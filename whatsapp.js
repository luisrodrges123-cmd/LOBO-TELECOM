import crypto from "node:crypto";

const GRAPH_VERSION = process.env.WHATSAPP_API_VERSION || "v25.0";
const PHONE_ID = process.env.WHATSAPP_PHONE_NUMBER_ID || "";
const ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN || "";

export class WhatsAppCloudClient {
  constructor() {
    this.onMessage = null;
  }

  snapshot() {
    const missing = [];
    if (!PHONE_ID) missing.push("WHATSAPP_PHONE_NUMBER_ID");
    if (!ACCESS_TOKEN) missing.push("WHATSAPP_ACCESS_TOKEN");
    if (!process.env.WHATSAPP_TEMPLATE_NAME || process.env.WHATSAPP_TEMPLATE_NAME === "3p_direct_integration_test_template") missing.push("WHATSAPP_TEMPLATE_NAME (plantilla aprobada de avisos)");
    const webhookMissing = [];
    if (!process.env.WHATSAPP_VERIFY_TOKEN) webhookMissing.push("WHATSAPP_VERIFY_TOKEN");
    if (!process.env.WHATSAPP_APP_SECRET) webhookMissing.push("WHATSAPP_APP_SECRET");
    return {
      provider: "Meta WhatsApp Business Cloud API",
      configured: missing.length === 0,
      webhookConfigured: webhookMissing.length === 0,
      state: missing.length ? "setup_required" : "ready",
      missing,
      webhookMissing,
      phoneLast4: PHONE_ID ? PHONE_ID.slice(-4) : ""
    };
  }

  async request(to, payload) {
    if (!PHONE_ID || !ACCESS_TOKEN) throw new Error("Falta configurar WHATSAPP_PHONE_NUMBER_ID y WHATSAPP_ACCESS_TOKEN en Render.");
    const response = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${PHONE_ID}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", to, ...payload })
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      const metaError = result.error || {};
      const error = new Error(metaError.error_user_msg || metaError.message || `Meta Graph API devolvió HTTP ${response.status}.`);
      error.code = metaError.code;
      error.statusCode = response.status;
      error.retryable = response.status === 429 || response.status >= 500;
      throw error;
    }
    return result;
  }

  async sendText(to, text) {
    const recipient = normalizeWhatsAppNumber(to);
    if (!recipient) throw new Error("El número del destinatario no es válido.");
    return this.request(recipient, { type: "text", text: { preview_url: false, body: String(text).slice(0, 4096) } });
  }

  async sendPackageTemplate(to, { recipient, folio, tracking, status, carrier }) {
    const name = process.env.WHATSAPP_TEMPLATE_NAME || "";
    const language = process.env.WHATSAPP_TEMPLATE_LANGUAGE || "es_MX";
    if (!name || name === "3p_direct_integration_test_template") throw new Error("Falta una plantilla aprobada de avisos de paquetes con cinco variables; la plantilla de prueba de Meta no contiene esos datos.");
    const number = normalizeWhatsAppNumber(to);
    if (!number) throw new Error("El número del destinatario no es válido.");
    const parameters = [recipient, folio, tracking, status, carrier].map(text => ({ type: "text", text: String(text || "-").slice(0, 1024) }));
    return this.request(number, {
      type: "template",
      template: { name, language: { code: language }, components: [{ type: "body", parameters }] }
    });
  }
}

export function normalizeWhatsAppNumber(value) {
  let digits = String(value || "").replace(/\D/g, "");
  if (digits.length === 10) digits = `52${digits}`;
  if (digits.length === 13 && digits.startsWith("521")) digits = `52${digits.slice(-10)}`;
  return digits;
}

export function verifyWhatsAppSignature(rawBody, signature, appSecret) {
  if (!rawBody || !signature || !appSecret) return false;
  const expected = crypto.createHmac("sha256", appSecret).update(rawBody).digest();
  let received;
  try { received = Buffer.from(String(signature).replace(/^sha256=/, ""), "hex"); }
  catch { return false; }
  return received.length === expected.length && crypto.timingSafeEqual(received, expected);
}

