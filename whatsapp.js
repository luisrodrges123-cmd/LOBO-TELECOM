import crypto from "crypto";
import makeWASocket, {
  BufferJSON,
  DisconnectReason,
  initAuthCreds,
  makeCacheableSignalKeyStore,
  proto
} from "@whiskeysockets/baileys";
import QRCode from "qrcode";
import pino from "pino";

const AUTH_PREFIX = "baileys:";
const logger = pino({ level: "silent" });

function getEncryptionKey() {
  const encoded = process.env.WHATSAPP_SESSION_ENCRYPTION_KEY || "";
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32) throw new Error("Falta WHATSAPP_SESSION_ENCRYPTION_KEY de 32 bytes en base64.");
  return key;
}

function encrypt(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", getEncryptionKey(), iv);
  const plaintext = Buffer.from(JSON.stringify(value, BufferJSON.replacer));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return [iv, cipher.getAuthTag(), ciphertext].map(part => part.toString("base64")).join(".");
}

function decrypt(value) {
  const [ivText, tagText, dataText] = String(value).split(".");
  if (!ivText || !tagText || !dataText) throw new Error("La sesión guardada de WhatsApp está dañada.");
  const decipher = crypto.createDecipheriv("aes-256-gcm", getEncryptionKey(), Buffer.from(ivText, "base64"));
  decipher.setAuthTag(Buffer.from(tagText, "base64"));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(dataText, "base64")), decipher.final()]);
  return JSON.parse(plaintext.toString("utf8"), BufferJSON.reviver);
}

async function readAuth(pool, id) {
  const { rows } = await pool.query("SELECT payload FROM whatsapp_auth WHERE id=$1", [id]);
  return rows.length ? decrypt(rows[0].payload) : null;
}

async function createAuthState(pool) {
  const creds = await readAuth(pool, `${AUTH_PREFIX}creds`) || initAuthCreds();
  const keys = {
    get: async (type, ids) => {
      const values = await Promise.all(ids.map(id => readAuth(pool, `${AUTH_PREFIX}key:${type}:${id}`)));
      const result = {};
      ids.forEach((id, index) => {
        let value = values[index];
        if (type === "app-state-sync-key" && value) value = proto.Message.AppStateSyncKeyData.fromObject(value);
        result[id] = value;
      });
      return result;
    },
    set: async data => {
      const writes = [];
      const deletes = [];
      for (const type of Object.keys(data)) {
        for (const [id, value] of Object.entries(data[type] || {})) {
          const authId = `${AUTH_PREFIX}key:${type}:${id}`;
          if (value == null) deletes.push(authId);
          else writes.push([authId, encrypt(value)]);
        }
      }
      if (!writes.length && !deletes.length) return;
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        for (const [id, payload] of writes) {
          await client.query(
            "INSERT INTO whatsapp_auth(id,payload) VALUES($1,$2) ON CONFLICT(id) DO UPDATE SET payload=EXCLUDED.payload,updated_at=NOW()",
            [id, payload]
          );
        }
        if (deletes.length) await client.query("DELETE FROM whatsapp_auth WHERE id=ANY($1::text[])", [deletes]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }
  };

  return {
    state: { creds, keys: makeCacheableSignalKeyStore(keys, logger) },
    saveCreds: async () => {
      const payload = encrypt(creds);
      await pool.query(
        "INSERT INTO whatsapp_auth(id,payload) VALUES($1,$2) ON CONFLICT(id) DO UPDATE SET payload=EXCLUDED.payload,updated_at=NOW()",
        [`${AUTH_PREFIX}creds`, payload]
      );
    }
  };
}

export class WhatsAppBot {
  constructor({ pool, onMessage, onMessageUpdate }) {
    this.pool = pool;
    this.onMessage = onMessage;
    this.onMessageUpdate = onMessageUpdate;
    this.socket = null;
    this.reconnectTimer = null;
    this.reconnectEnabled = false;
    this.status = { state: "disconnected", qr: null, qrExpiresAt: null, phone: null, message: "Vincula el WhatsApp de LOBO TELECOM escaneando el QR." };
    this.starting = null;
  }

  snapshot() {
    return {
      ...this.status,
      connected: this.status.state === "connected",
      configured: Boolean(process.env.WHATSAPP_SESSION_ENCRYPTION_KEY)
    };
  }

  async resume() {
    try {
      const creds = await readAuth(this.pool, `${AUTH_PREFIX}creds`);
      if (creds?.registered) await this.connect();
    } catch (error) {
      console.error("No se pudo restaurar la sesión cifrada de WhatsApp:", error.message);
      this.status = { ...this.status, state: "error", qr: null, message: "No se pudo abrir la sesión guardada. Revisa la llave de cifrado." };
    }
  }

  async connect() {
    if (this.status.state === "connected" || this.status.state === "qr" || this.status.state === "connecting" || this.status.state === "reconnecting") return this.snapshot();
    getEncryptionKey();
    this.reconnectEnabled = true;
    this.status = { ...this.status, state: "connecting", qr: null, qrExpiresAt: null, message: "Conectando con WhatsApp para generar el QR…" };
    this.starting = this.openSocket();
    try { await this.starting; }
    catch (error) {
      this.status = { state: "error", qr: null, qrExpiresAt: null, phone: null, message: "No se pudo iniciar WhatsApp. Revisa la llave privada y vuelve a intentar." };
      throw error;
    } finally { this.starting = null; }
    return this.snapshot();
  }

  async openSocket() {
    if (this.socket) return;
    const auth = await createAuthState(this.pool);
    const socket = makeWASocket({
      auth: auth.state,
      logger,
      printQRInTerminal: false,
      markOnlineOnConnect: false,
      syncFullHistory: false,
      browser: ["LOBO TELECOM", "Chrome", "1.0.0"]
    });
    this.socket = socket;
    socket.ev.on("creds.update", () => auth.saveCreds().catch(error => console.error("No se pudieron guardar las credenciales cifradas de WhatsApp:", error.message)));
    socket.ev.on("connection.update", update => { void this.handleConnectionUpdate(socket, update); });
    socket.ev.on("messages.upsert", event => {
      void this.handleMessages(event).catch(error => console.error("Error leyendo mensajes de WhatsApp:", error.message));
    });
    socket.ev.on("messages.update", updates => {
      for (const item of updates || []) {
        if (!item.key?.fromMe || !item.key?.id || !Number.isInteger(item.update?.status)) continue;
        void Promise.resolve(this.onMessageUpdate?.(item.key.id, item.update.status, item.update))
          .catch(error => console.error("No se pudo registrar la confirmación de entrega de WhatsApp:", error.message));
      }
    });
  }

  async handleConnectionUpdate(socket, update) {
    if (socket !== this.socket) return;
    if (update.qr) {
      try {
        const qr = await QRCode.toDataURL(update.qr, { width: 280, margin: 2, errorCorrectionLevel: "M" });
        if (socket !== this.socket) return;
        this.status = { state: "qr", qr, qrExpiresAt: new Date(Date.now() + 55_000).toISOString(), phone: null, message: "Abre WhatsApp en tu celular y escanea este QR en Dispositivos vinculados." };
      } catch (error) {
        console.error("No se pudo generar el QR de WhatsApp:", error.message);
        this.status = { state: "error", qr: null, qrExpiresAt: null, phone: null, message: "No se pudo generar el QR. Vuelve a intentarlo." };
      }
    }
    if (update.connection === "open") {
      const phone = String(socket.user?.id || "").split(":")[0].split("@")[0];
      this.status = { state: "connected", qr: null, qrExpiresAt: null, phone, message: "WhatsApp está conectado y el bot puede responder consultas." };
      console.info(`WhatsApp conectado; cuenta terminada en ${phone.slice(-4)}.`);
    }
    if (update.connection === "close") {
      this.socket = null;
      this.status = { ...this.status, qr: null, qrExpiresAt: null, phone: null };
      const code = update.lastDisconnect?.error?.output?.statusCode;
      console.warn(`Conexión WhatsApp cerrada (código ${code ?? "desconocido"}).`);
      if (code === DisconnectReason.loggedOut) {
        this.reconnectEnabled = false;
        await this.clearAuth();
        this.status = { state: "disconnected", qr: null, qrExpiresAt: null, phone: null, message: "WhatsApp se desvinculó. Genera un QR nuevo para conectarlo." };
      } else if (this.reconnectEnabled) {
        this.status = { state: "reconnecting", qr: null, qrExpiresAt: null, phone: null, message: "WhatsApp se desconectó; intentando restablecer la conexión…" };
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = setTimeout(() => {
          if (this.reconnectEnabled) void this.openSocket().catch(error => this.failReconnect(error));
        }, 3000);
      } else {
        this.status = { state: "disconnected", qr: null, qrExpiresAt: null, phone: null, message: "WhatsApp está desconectado." };
      }
    }
  }

  async handleMessages(event) {
    if (event.type !== "notify") return;
    for (const message of event.messages || []) {
      if (message.key?.fromMe || !message.key?.id || !message.message) continue;
      const jid = message.key.remoteJid;
      const alternateJid = message.key.remoteJidAlt || message.key.participantAlt || "";
      if (!jid || jid === "status@broadcast" || jid.endsWith("@g.us") || jid.endsWith("@newsletter")) continue;
      const phoneJid = [alternateJid, jid].find(value => String(value).endsWith("@s.whatsapp.net")) || jid;
      const sender = String(phoneJid).split("@")[0].split(":")[0];
      const content = message.message.ephemeralMessage?.message || message.message.viewOnceMessage?.message || message.message;
      const text = content.conversation || content.extendedTextMessage?.text || content.imageMessage?.caption || content.videoMessage?.caption || "";
      const id = `${AUTH_PREFIX}message:${message.key.id}`;
      const { rows } = await this.pool.query("INSERT INTO whatsapp_processed_messages(message_id) VALUES($1) ON CONFLICT DO NOTHING RETURNING message_id", [id]);
      if (!rows.length) continue;
      try {
        await this.onMessage(jid, sender, text, alternateJid);
      } catch (error) {
        await this.pool.query("DELETE FROM whatsapp_processed_messages WHERE message_id=$1", [id]);
        console.error("No se pudo responder un mensaje entrante de WhatsApp:", error.message, error.stack || "");
      }
    }
  }

  async sendText(jid, text) {
    if (!this.socket || this.status.state !== "connected") throw new Error("WhatsApp todavía no está conectado. Escanea el QR desde el administrador.");
    return this.socket.sendMessage(jid, { text });
  }

  async disconnect() {
    this.reconnectEnabled = false;
    clearTimeout(this.reconnectTimer);
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      try { if (socket.user) await socket.logout(); else socket.end(undefined); } catch { socket.end(undefined); }
    }
    await this.clearAuth();
    this.status = { state: "disconnected", qr: null, qrExpiresAt: null, phone: null, message: "WhatsApp se desconectó y la sesión se eliminó del servidor." };
    return this.snapshot();
  }

  async clearAuth() {
    await this.pool.query("DELETE FROM whatsapp_auth WHERE id LIKE $1", [`${AUTH_PREFIX}%`]);
  }

  failReconnect(error) {
    console.error("No se pudo restablecer WhatsApp:", error.message);
    this.status = { state: "error", qr: null, qrExpiresAt: null, phone: null, message: "No se pudo reconectar. Intenta generar un QR nuevo." };
  }
}

export function phoneToWhatsAppJid(value) {
  let digits = String(value || "").replace(/\D/g, "");
  if (digits.length === 10) digits = `52${digits}`;
  if (digits.length === 13 && digits.startsWith("521")) digits = `52${digits.slice(-10)}`;
  return digits ? `${digits}@s.whatsapp.net` : "";
}





