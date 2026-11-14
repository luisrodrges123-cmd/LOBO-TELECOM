import express from "express";
import helmet from "helmet";
import cors from "cors";
import rateLimit from "express-rate-limit";
import jwt from "jsonwebtoken";
import pg from "pg";
import crypto from "crypto";

const { Pool } = pg;
const app = express();
app.set("trust proxy", 1);
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" },
  contentSecurityPolicy: {
    directives: {
      ...helmet.contentSecurityPolicy.getDefaultDirectives(),
      scriptSrc: ["'self'", "https://unpkg.com"],
      connectSrc: ["'self'", "https://unpkg.com"],
      imgSrc: ["'self'", "data:", "blob:"],
      workerSrc: ["'self'", "blob:"]
    }
  }
}));
const origins = (process.env.ALLOWED_ORIGINS || "http://localhost:3000").split(",").map(s => s.trim());
app.use(cors({ origin: (origin, cb) => {
  if (!origin || origins.includes("*") || origins.includes(origin)) return cb(null, true);
  return cb(new Error("Origen no permitido por CORS"));
}}));
app.use(express.json({ limit: "30kb" }));
app.use(express.static("public"));
app.use("/api", rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: "draft-7", legacyHeaders: false }));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : undefined
});
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET || JWT_SECRET.length < 32 || JWT_SECRET.includes("CAMBIA_ESTA")) {
  throw new Error("JWT_SECRET debe tener al menos 32 caracteres y ser único.");
}
if (!process.env.ADMIN_PASSWORD || process.env.ADMIN_PASSWORD.includes("CAMBIA_ESTA")) {
  throw new Error("Configura ADMIN_PASSWORD antes de iniciar el servidor.");
}

async function dbInit() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS packages (
      id BIGSERIAL PRIMARY KEY,
      tracking_code TEXT UNIQUE NOT NULL,
      folio TEXT UNIQUE NOT NULL,
      recipient_name TEXT DEFAULT '',
      phone TEXT DEFAULT '',
      carrier TEXT DEFAULT 'Mercado Libre',
      status TEXT NOT NULL DEFAULT 'received',
      notes TEXT DEFAULT '',
      received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      delivered_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS packages_phone_idx ON packages(phone);
    CREATE INDEX IF NOT EXISTS packages_status_idx ON packages(status);
    CREATE TABLE IF NOT EXISTS package_events (
      id BIGSERIAL PRIMARY KEY,
      package_id BIGINT REFERENCES packages(id) ON DELETE CASCADE,
      event TEXT NOT NULL,
      detail TEXT DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE packages ADD COLUMN IF NOT EXISTS whatsapp_opt_in BOOLEAN NOT NULL DEFAULT FALSE;
  `);
}
const asyncRoute = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
function auth(req, res, next) {
  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  try {
    req.admin = jwt.verify(token, JWT_SECRET);
    next();
  } catch { res.status(401).json({ error: "Sesión no válida. Inicia sesión nuevamente." }); }
}
function clean(v, max=180) { return String(v ?? "").trim().slice(0, max); }
function normalizePhone(v) { return String(v ?? "").replace(/\D/g, "").slice(-15); }
function makeFolio() { return "LT-" + new Date().toISOString().slice(2,10).replaceAll("-","") + "-" + crypto.randomBytes(3).toString("hex").toUpperCase(); }

app.get("/api/health", (req,res) => res.json({ ok:true, service:"LOBO TELECOM Paquetería" }));

app.post("/api/admin/login", rateLimit({ windowMs: 15*60_000, limit: 8 }), asyncRoute(async (req,res) => {
  const username = clean(req.body.username, 80);
  const password = String(req.body.password || "");
  const expectedUser = process.env.ADMIN_USER || "admin";
  const expectedPassword = process.env.ADMIN_PASSWORD || "";
  const same = (left, right) => {
    const a = Buffer.from(left);
    const b = Buffer.from(right);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  };
  if (!same(username, expectedUser) || !same(password, expectedPassword)) {
    return res.status(401).json({ error:"Usuario o contraseña incorrectos. Configura ADMIN_PASSWORD en el servidor." });
  }
  const token = jwt.sign({ sub: username, role:"admin" }, JWT_SECRET, { expiresIn:"10h" });
  res.json({ token, user: username, expiresIn:"10h" });
}));

app.get("/api/admin/packages", auth, asyncRoute(async (req,res) => {
  const q = clean(req.query.q, 100);
  const status = clean(req.query.status, 30);
  const params = [];
  let where = "WHERE 1=1";
  if (q) { params.push(`%${q}%`); where += ` AND (tracking_code ILIKE $${params.length} OR folio ILIKE $${params.length} OR recipient_name ILIKE $${params.length} OR phone ILIKE $${params.length})`; }
  if (status && ["received","ready","delivered","issue"].includes(status)) { params.push(status); where += ` AND status=$${params.length}`; }
  const { rows } = await pool.query(`SELECT * FROM packages ${where} ORDER BY created_at DESC LIMIT 300`, params);
  res.json({ packages: rows });
}));

app.post("/api/admin/packages", auth, asyncRoute(async (req,res) => {
  const tracking = clean(req.body.tracking_code, 120);
  if (!tracking) return res.status(400).json({ error:"El código de seguimiento es obligatorio." });
  const recipient = clean(req.body.recipient_name, 120);
  const phone = normalizePhone(req.body.phone);
  const carrier = clean(req.body.carrier || "Mercado Libre", 60);
  const notes = clean(req.body.notes, 500);
  const whatsappOptIn = req.body.whatsapp_opt_in === true;
  const folio = makeFolio();
  try {
    const client = await pool.connect();
    let rows;
    try {
      await client.query("BEGIN");
      ({ rows } = await client.query(
        `INSERT INTO packages(tracking_code,folio,recipient_name,phone,carrier,notes,whatsapp_opt_in,status)
       VALUES($1,$2,$3,$4,$5,$6,$7,'received') RETURNING *`,
      [tracking,folio,recipient,phone,carrier,notes,whatsappOptIn]
      ));
      await client.query("INSERT INTO package_events(package_id,event,detail) VALUES($1,'received','Paquete registrado por administrador')",[rows[0].id]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    const notification = whatsappOptIn && phone ? await notifyPackage(rows[0], "received") : { sent: false, reason: "consent_required" };
    res.status(201).json({ package: rows[0], notification });
  } catch (e) {
    if (e.code === "23505") return res.status(409).json({ error:"Ese número de seguimiento ya está registrado." });
    throw e;
  }
}));

app.patch("/api/admin/packages/:id", auth, asyncRoute(async (req,res) => {
  const id = Number(req.params.id);
  const status = clean(req.body.status, 20);
  if (!Number.isInteger(id) || !["received","ready","delivered","issue"].includes(status)) return res.status(400).json({error:"Datos inválidos."});
  const name = req.body.recipient_name === undefined ? null : clean(req.body.recipient_name,120);
  const phone = req.body.phone === undefined ? null : normalizePhone(req.body.phone);
  const notes = req.body.notes === undefined ? null : clean(req.body.notes,500);
  const deliveredAt = status === "delivered" ? "NOW()" : "NULL";
  const client = await pool.connect();
  let rows;
  let previous;
  try {
    await client.query("BEGIN");
    const current = await client.query("SELECT status FROM packages WHERE id=$1 FOR UPDATE", [id]);
    previous = current.rows[0];
    if (!previous) {
      await client.query("ROLLBACK");
      return res.status(404).json({error:"Paquete no encontrado."});
    }
    ({ rows } = await client.query(
      `UPDATE packages SET status=$1, recipient_name=COALESCE($2,recipient_name), phone=COALESCE($3,phone), notes=COALESCE($4,notes),
       whatsapp_opt_in=COALESCE($5,whatsapp_opt_in),
       delivered_at=${deliveredAt}, updated_at=NOW() WHERE id=$6 RETURNING *`,
      [status,name,phone,notes,req.body.whatsapp_opt_in === undefined ? null : req.body.whatsapp_opt_in === true,id]
    ));
    if (!rows[0]) {
      await client.query("ROLLBACK");
      return res.status(404).json({error:"Paquete no encontrado."});
    }
    await client.query("INSERT INTO package_events(package_id,event,detail) VALUES($1,$2,$3)",[id,status,"Estado actualizado desde administración"]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  let notification = { sent: false, reason: "status_unchanged_or_consent_required" };
  if (status !== previous.status && rows[0].whatsapp_opt_in && rows[0].phone) {
    notification = await notifyPackage(rows[0], status);
  }
  res.json({package:rows[0], notification});
}));

// Consulta pública: por teléfono devuelve únicamente folio, paquetería, estado y fechas.
// No expone domicilio, notas internas ni nombre completo.
app.post("/api/lookup", rateLimit({ windowMs: 10*60_000, limit: 15 }), asyncRoute(async (req,res) => {
  const phone = normalizePhone(req.body.phone);
  const folio = clean(req.body.folio, 80).toUpperCase();
  const tracking = clean(req.body.tracking_code, 120);
  if (!phone || (!folio && !tracking)) return res.status(400).json({error:"Ingresa tu teléfono y tu folio o número de seguimiento."});
  const field = folio ? "folio" : "tracking_code";
  const value = folio || tracking;
  const { rows } = await pool.query(
    `SELECT folio,tracking_code,carrier,status,received_at,delivered_at
     FROM packages WHERE ${field}=$1 AND phone=$2 LIMIT 1`, [value,phone]
  );
  if (!rows.length) return res.status(404).json({error:"No encontramos un paquete con esos datos. Verifica el folio/seguimiento y el teléfono registrado."});
  res.json({package:rows[0]});
}));

async function sendWhatsApp(to, message) {
  const token = process.env.WHATSAPP_TOKEN;
  const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!token || !phoneId) return { configured:false };
  const version = process.env.WHATSAPP_API_VERSION || "v27.0";
  const response = await fetch(`https://graph.facebook.com/${version}/${phoneId}/messages`, {
    method:"POST",
    headers:{ Authorization:`Bearer ${token}`, "Content-Type":"application/json" },
    body:JSON.stringify(message)
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || "No se pudo enviar WhatsApp.");
  return { configured:true, data };
}
async function notifyPackage(p, status) {
  if (!p.whatsapp_opt_in || !p.phone) return { sent: false, reason: "consent_required" };
  const state = status === "delivered" ? "entregado" : status === "ready" ? "listo para recoger" : status === "issue" ? "con una incidencia que requiere atención" : "recibido en LOBO TELECOM";
  const templateName = process.env.WHATSAPP_TEMPLATE_NAME;
  if (!templateName) return { sent: false, reason: "whatsapp_template_not_configured" };
  try {
    const result = await sendWhatsApp(p.phone, {
      messaging_product: "whatsapp",
      to: p.phone,
      type: "template",
      template: {
        name: templateName,
        language: { code: process.env.WHATSAPP_TEMPLATE_LANGUAGE || "es_MX" },
        components: [{ type: "body", parameters: [
          { type: "text", text: p.folio },
          { type: "text", text: state }
        ] }]
      }
    });
    return result.configured ? { sent: true } : { sent: false, reason: "whatsapp_not_configured" };
  } catch {
    return { sent: false, reason: "whatsapp_send_failed" };
  }
}
app.post("/api/admin/packages/:id/notify", auth, asyncRoute(async (req,res) => {
  const { rows } = await pool.query("SELECT * FROM packages WHERE id=$1",[Number(req.params.id)]);
  const p = rows[0];
  if (!p) return res.status(404).json({error:"Paquete no encontrado."});
  if (!p.phone) return res.status(400).json({error:"Agrega el teléfono del destinatario primero."});
  if (!p.whatsapp_opt_in) return res.status(400).json({error:"Registra primero la autorización del destinatario para recibir mensajes por WhatsApp."});
  const result = await notifyPackage(p, p.status);
  if (!result.sent) return res.status(503).json({error: result.reason === "whatsapp_not_configured" ? "WhatsApp todavía no está configurado. Agrega WHATSAPP_TOKEN y WHATSAPP_PHONE_NUMBER_ID." : result.reason === "whatsapp_template_not_configured" ? "Configura el nombre de una plantilla aprobada de WhatsApp." : "No se pudo enviar el aviso. Revisa la configuración de WhatsApp e inténtalo de nuevo."});
  res.json({ok:true,message:"Solicitud enviada a WhatsApp."});
}));

// Webhook básico para verificación de Meta; falta configurar la URL en el panel de Meta.
app.get("/api/whatsapp/webhook", (req,res) => {
  const mode=req.query["hub.mode"], token=req.query["hub.verify_token"], challenge=req.query["hub.challenge"];
  if (mode==="subscribe" && token===process.env.WHATSAPP_VERIFY_TOKEN) return res.status(200).send(challenge);
  res.sendStatus(403);
});
app.post("/api/whatsapp/webhook", (req,res) => res.sendStatus(200));

app.use((err,req,res,next) => {
  if (err.message === "Origen no permitido por CORS") return res.status(403).json({ error: "Origen no permitido." });
  console.error(err);
  res.status(500).json({error:"Error interno del servidor."});
});
const port = Number(process.env.PORT || 3000);
dbInit().then(() => app.listen(port, () => console.log(`LOBO TELECOM activo en puerto ${port}`)))
  .catch(err => { console.error("No se pudo iniciar la base de datos:",err); process.exit(1); });
