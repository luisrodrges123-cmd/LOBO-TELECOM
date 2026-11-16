import express from "express";
import helmet from "helmet";
import cors from "cors";
import rateLimit from "express-rate-limit";
import jwt from "jsonwebtoken";
import pg from "pg";
import crypto from "crypto";
import { WhatsAppCloudClient, normalizeWhatsAppNumber, verifyWhatsAppSignature } from "./whatsapp.js";

const { Pool } = pg;
const app = express();
app.set("trust proxy", 1);
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" },
  contentSecurityPolicy: {
    directives: {
      ...helmet.contentSecurityPolicy.getDefaultDirectives(),
      "script-src": ["'self'", "https://unpkg.com"],
      "connect-src": ["'self'", "https://unpkg.com"],
      "img-src": ["'self'", "data:", "blob:"],
      "worker-src": ["'self'", "blob:"]
    }
  }
}));
const origins = [
  ...(process.env.ALLOWED_ORIGINS || "http://localhost:3000").split(",").map(s => s.trim()),
  process.env.RENDER_EXTERNAL_URL
].filter(Boolean);
app.use(cors({ origin: (origin, cb) => {
  if (!origin || origins.includes("*") || origins.includes(origin)) return cb(null, true);
  return cb(new Error("Origen no permitido por CORS"));
}}));
app.use(express.json({ limit: "30kb", verify: (req, res, buffer) => { req.rawBody = Buffer.from(buffer); } }));
app.use(express.static("public"));
app.use("/api", rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: "draft-7", legacyHeaders: false }));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : undefined
});
const whatsappBot = new WhatsAppCloudClient();

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
      recipient_address TEXT DEFAULT '',
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
    ALTER TABLE packages ADD COLUMN IF NOT EXISTS recipient_address TEXT NOT NULL DEFAULT '';
    CREATE TABLE IF NOT EXISTS staff_users (
      id BIGSERIAL PRIMARY KEY, username TEXT UNIQUE NOT NULL, display_name TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('warehouse','courier')), password_hash TEXT NOT NULL,
      password_salt TEXT NOT NULL, can_register_packages BOOLEAN NOT NULL DEFAULT TRUE, active BOOLEAN NOT NULL DEFAULT TRUE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE staff_users ADD COLUMN IF NOT EXISTS can_register_packages BOOLEAN NOT NULL DEFAULT TRUE;
    CREATE TABLE IF NOT EXISTS whatsapp_processed_messages (
      message_id TEXT PRIMARY KEY,
      received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS whatsapp_auth (
      id TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS whatsapp_message_receipts (message_id TEXT PRIMARY KEY,status SMALLINT NOT NULL,updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS whatsapp_notifications (
      id BIGSERIAL PRIMARY KEY,
      package_id BIGINT REFERENCES packages(id) ON DELETE CASCADE,
      package_status TEXT NOT NULL,
      delivery_state TEXT NOT NULL CHECK (delivery_state IN ('sent','failed','skipped')),
      reason TEXT NOT NULL DEFAULT '',
      whatsapp_message_id TEXT DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE whatsapp_notifications DROP CONSTRAINT IF EXISTS whatsapp_notifications_delivery_state_check;
    ALTER TABLE whatsapp_notifications ADD CONSTRAINT whatsapp_notifications_delivery_state_check CHECK (delivery_state IN ('sent','accepted','delivered','read','played','failed','skipped','queued','sending'));
    ALTER TABLE whatsapp_notifications ADD COLUMN IF NOT EXISTS attempt_count INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE whatsapp_notifications ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ;
    ALTER TABLE whatsapp_notifications ADD COLUMN IF NOT EXISTS last_attempt_at TIMESTAMPTZ;
    ALTER TABLE whatsapp_notifications ADD COLUMN IF NOT EXISTS last_error TEXT NOT NULL DEFAULT '';
    ALTER TABLE whatsapp_notifications ADD COLUMN IF NOT EXISTS whatsapp_receipt_status SMALLINT;
    UPDATE whatsapp_notifications SET delivery_state='accepted',reason='server_accepted_pending_receipt' WHERE delivery_state='sent';
    UPDATE whatsapp_notifications SET delivery_state='queued',next_attempt_at=NOW(),reason='retry_after_restart' WHERE delivery_state='sending';
    CREATE INDEX IF NOT EXISTS whatsapp_notifications_created_idx ON whatsapp_notifications(created_at DESC);
    CREATE INDEX IF NOT EXISTS whatsapp_notifications_queue_idx ON whatsapp_notifications(next_attempt_at) WHERE delivery_state='queued';
  `);
}
const asyncRoute = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
async function auth(req, res, next) {
  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  try {
    req.admin = jwt.verify(token, JWT_SECRET);
    if(req.admin.role !== "admin") {
      const {rows}=await pool.query("SELECT role,can_register_packages FROM staff_users WHERE username=$1 AND active=TRUE",[req.admin.sub]);
      if(!rows[0] || rows[0].role!==req.admin.role) return res.status(401).json({error:"Esta cuenta ya no tiene acceso. Inicia sesión nuevamente."});
      req.admin.can_register_packages=rows[0].role==="warehouse" && rows[0].can_register_packages===true;
    }
    next();
  } catch { res.status(401).json({ error: "Sesión no válida. Inicia sesión nuevamente." }); }
}
function adminOnly(req,res,next) { if(req.admin?.role !== 'admin') return res.status(403).json({error:'Esta función es exclusiva del administrador.'}); next(); }
function roleOnly(role) { return (req,res,next) => req.admin?.role === role ? next() : res.status(403).json({error:'No tienes permiso para esta sección.'}); }
function warehouseRegisterOnly(req,res,next) { if(req.admin?.role!=="warehouse" || req.admin?.can_register_packages!==true) return res.status(403).json({error:"Tu usuario de almacén no tiene permiso para registrar paquetes."}); next(); }
function clean(v, max=180) { return String(v ?? "").trim().slice(0, max); }
function normalizePhone(v) { return String(v ?? "").replace(/\D/g, "").slice(-15); }
function makeFolio() { return "LT-" + new Date().toISOString().slice(2,10).replaceAll("-","") + "-" + crypto.randomBytes(3).toString("hex").toUpperCase(); }

app.get("/api/health", (req,res) => res.json({ ok:true, service:"LOBO TELECOM Paquetería" }));

app.post("/api/admin/login", rateLimit({ windowMs: 15*60_000, limit: 8 }), asyncRoute(async (req,res) => {
  const username=clean(req.body.username,80),password=String(req.body.password||"");
  const expectedUser=process.env.ADMIN_USER||"admin",expectedPassword=process.env.ADMIN_PASSWORD||"";
  const same=(left,right)=>{const a=Buffer.from(left),b=Buffer.from(right);return a.length===b.length&&crypto.timingSafeEqual(a,b);};
  if(!same(username,expectedUser)||!same(password,expectedPassword))return res.status(401).json({error:"Credenciales de administrador incorrectas."});
  const token=jwt.sign({sub:username,role:"admin"},JWT_SECRET,{expiresIn:"10h"});
  res.json({token,user:username,role:"admin",expiresIn:"10h"});
}));
app.post("/api/staff/login", rateLimit({ windowMs: 15*60_000, limit: 8 }), asyncRoute(async(req,res)=>{
  const username=clean(req.body.username,80),password=String(req.body.password||"");
  const {rows}=await pool.query("SELECT username,role,password_hash,password_salt FROM staff_users WHERE lower(username)=lower($1) AND active=TRUE",[username]);
  const user=rows[0];let valid=false;
  if(user){const candidate=crypto.scryptSync(password,user.password_salt,64),saved=Buffer.from(user.password_hash,"hex");valid=saved.length===candidate.length&&crypto.timingSafeEqual(saved,candidate);}
  if(!valid)return res.status(401).json({error:"Usuario o contraseña de equipo incorrectos."});
  const token=jwt.sign({sub:user.username,role:user.role},JWT_SECRET,{expiresIn:"10h"});
  res.json({token,user:user.username,role:user.role,expiresIn:"10h"});
}));

app.get("/api/admin/users",auth,adminOnly,asyncRoute(async(req,res)=>{
  const {rows}=await pool.query("SELECT id,username,display_name,role,active,can_register_packages,created_at FROM staff_users ORDER BY created_at DESC");
  res.json({users:rows});
}));
app.post("/api/admin/users",auth,adminOnly,asyncRoute(async(req,res)=>{
  const username=clean(req.body.username,50).trim(), displayName=clean(req.body.display_name,100).trim();
  const role=clean(req.body.role,20), password=String(req.body.password||"");
  const canRegisterPackages=role==="warehouse" && req.body.can_register_packages!==false;
  if(!/^[a-zA-Z0-9._-]{3,50}$/.test(username)||!displayName||!['warehouse','courier'].includes(role)||password.length<10)
    return res.status(400).json({error:"Ingresa usuario válido, nombre, rol y contraseña de al menos 10 caracteres."});
  const salt=crypto.randomBytes(16).toString("hex"), hash=crypto.scryptSync(password,salt,64).toString("hex");
  try{const {rows}=await pool.query("INSERT INTO staff_users(username,display_name,role,password_hash,password_salt,can_register_packages) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,username,display_name,role,active,can_register_packages,created_at",[username,displayName,role,hash,salt,canRegisterPackages]);res.status(201).json({user:rows[0]});}
  catch(error){if(error.code==="23505")return res.status(409).json({error:"Ese nombre de usuario ya existe."});throw error;}
}));
app.patch("/api/admin/users/:id",auth,adminOnly,asyncRoute(async(req,res)=>{
  const id=Number(req.params.id),canRegisterPackages=req.body.can_register_packages;
  if(!Number.isSafeInteger(id)||typeof canRegisterPackages!=="boolean")return res.status(400).json({error:"Indica un permiso de registro válido."});
  const current=await pool.query("SELECT role FROM staff_users WHERE id=$1",[id]);
  if(!current.rows[0])return res.status(404).json({error:"No se encontró el usuario."});
  if(current.rows[0].role!=="warehouse")return res.status(400).json({error:"Este permiso solo se configura para usuarios de almacén."});
  const {rows}=await pool.query("UPDATE staff_users SET can_register_packages=$2 WHERE id=$1 RETURNING id,username,display_name,role,active,can_register_packages,created_at",[id,canRegisterPackages]);
  res.json({user:rows[0],message:canRegisterPackages?"Almacén puede registrar paquetes.":"Se quitó el permiso para registrar paquetes."});
}));

app.delete("/api/admin/users/:id",auth,adminOnly,asyncRoute(async(req,res)=>{
  const id=Number(req.params.id);if(!Number.isSafeInteger(id))return res.status(400).json({error:"Usuario no válido."});
  const {rows}=await pool.query("DELETE FROM staff_users WHERE id=$1 RETURNING username",[id]);
  if(!rows[0])return res.status(404).json({error:"No se encontró el usuario."});
  res.json({ok:true,message:`Se eliminó el usuario ${rows[0].username}.`});
}));

app.get("/api/admin/packages", auth, adminOnly, asyncRoute(async (req,res) => {
  const q = clean(req.query.q, 100);
  const status = clean(req.query.status, 30);
  const params = [];
  let where = "WHERE 1=1";
  if (q) { params.push(`%${q}%`); where += ` AND (tracking_code ILIKE $${params.length} OR folio ILIKE $${params.length} OR recipient_name ILIKE $${params.length} OR phone ILIKE $${params.length})`; }
  if (status && ["received","ready","delivered","issue"].includes(status)) { params.push(status); where += ` AND status=$${params.length}`; }
  const { rows } = await pool.query(`SELECT * FROM packages ${where} ORDER BY created_at DESC LIMIT 300`, params);
  res.json({ packages: rows });
}));

app.post("/api/admin/packages", auth, adminOnly, asyncRoute(async (req,res) => {
  const tracking = clean(req.body.tracking_code, 120);
  if (!tracking) return res.status(400).json({ error:"El código de seguimiento es obligatorio." });
  const recipient = clean(req.body.recipient_name, 120);
  const address = clean(req.body.recipient_address, 300);
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
        `INSERT INTO packages(tracking_code,folio,recipient_name,phone,recipient_address,carrier,notes,whatsapp_opt_in,status)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,'received') RETURNING *`,
      [tracking,folio,recipient,phone,address,carrier,notes,whatsappOptIn]
      ));
      await client.query("INSERT INTO package_events(package_id,event,detail) VALUES($1,'received','Paquete registrado por administrador')",[rows[0].id]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    const notification = await notifyPackage(rows[0], "received");
    res.status(201).json({ package: rows[0], notification });
  } catch (e) {
    if (e.code === "23505") return res.status(409).json({ error:"Ese número de seguimiento ya está registrado." });
    throw e;
  }
}));

app.patch("/api/admin/packages/:id", auth, adminOnly, asyncRoute(async (req,res) => {
  const id = Number(req.params.id);
  const status = clean(req.body.status, 20);
  if (!Number.isInteger(id) || !["received","ready","delivered","issue"].includes(status)) return res.status(400).json({error:"Datos inválidos."});
  const name = req.body.recipient_name === undefined ? null : clean(req.body.recipient_name,120);
  const phone = req.body.phone === undefined ? null : normalizePhone(req.body.phone);
  const address = req.body.recipient_address === undefined ? null : clean(req.body.recipient_address,1200);
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
       whatsapp_opt_in=COALESCE($5,whatsapp_opt_in), recipient_address=COALESCE($6,recipient_address),
       delivered_at=${deliveredAt}, updated_at=NOW() WHERE id=$7 RETURNING *`,
      [status,name,phone,notes,req.body.whatsapp_opt_in === undefined ? null : req.body.whatsapp_opt_in === true,address,id]
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
  let notification = { sent: false, reason: "status_unchanged" };
  if (status !== previous.status) notification = await notifyPackage(rows[0], status);
  res.json({package:rows[0], notification});
}));

app.delete("/api/admin/packages/:id",auth,adminOnly,asyncRoute(async(req,res)=>{
  const id=Number(req.params.id);if(!Number.isSafeInteger(id))return res.status(400).json({error:"Paquete no válido."});
  const {rows}=await pool.query("DELETE FROM packages WHERE id=$1 RETURNING folio,tracking_code",[id]);
  if(!rows[0])return res.status(404).json({error:"No se encontró el paquete."});
  res.json({ok:true,message:`Se eliminó el paquete ${rows[0].folio}.`});
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

const CLOUD_RECEIPT_CODES = { failed: 0, sent: 2, delivered: 3, read: 4 };
const CLOUD_RECEIPT_STATES = { 0: "failed", 2: "accepted", 3: "delivered", 4: "read" };
async function handleWhatsAppCloudStatus(messageId, status, errors=[]) {
  const code = CLOUD_RECEIPT_CODES[status];
  if (code === undefined) return;
  const { rows } = await pool.query(
    `INSERT INTO whatsapp_message_receipts(message_id,status) VALUES($1,$2)
     ON CONFLICT(message_id) DO UPDATE SET status=CASE
       WHEN whatsapp_message_receipts.status=0 THEN EXCLUDED.status
       WHEN EXCLUDED.status=0 THEN whatsapp_message_receipts.status
       ELSE GREATEST(whatsapp_message_receipts.status,EXCLUDED.status) END,updated_at=NOW()
     RETURNING status`, [messageId, code]
  );
  const effective = Number(rows[0]?.status);
  const state = CLOUD_RECEIPT_STATES[effective];
  if (!state) return;
  const reason = state === "failed" ? "meta_delivery_failed" : state === "accepted" ? "meta_accepted_pending_receipt" : state;
  const detail = errors?.[0]?.error_data?.details || errors?.[0]?.message || errors?.[0]?.title || "Meta reportó un error de entrega.";
  await pool.query(
    `UPDATE whatsapp_notifications SET delivery_state=$2,reason=$3,whatsapp_receipt_status=$4,
       last_error=CASE WHEN $2='failed' THEN $5 ELSE '' END
     WHERE whatsapp_message_id=$1 AND delivery_state NOT IN ('skipped','queued','sending')
       AND (whatsapp_receipt_status IS NULL OR whatsapp_receipt_status < $4 OR (whatsapp_receipt_status=0 AND $4>0))`,
    [messageId, state, reason, effective, String(detail).slice(0,500)]
  );
}
async function processWhatsAppWebhook(payload) {
  for (const entry of payload?.entry || []) for (const change of entry.changes || []) {
    const value = change.value || {};
    for (const status of value.statuses || []) await handleWhatsAppCloudStatus(status.id, status.status, status.errors || []);
    for (const incoming of value.messages || []) {
      if (!incoming.id || !incoming.from) continue;
      const content = incoming.text?.body || incoming.button?.text || incoming.interactive?.button_reply?.title || incoming.interactive?.list_reply?.title || "";
      const key = `cloud:${incoming.id}`;
      const { rows } = await pool.query("INSERT INTO whatsapp_processed_messages(message_id) VALUES($1) ON CONFLICT DO NOTHING RETURNING message_id", [key]);
      if (!rows.length) continue;
      try { await handleIncomingWhatsAppMessage(incoming.from, incoming.from, content); }
      catch (error) {
        await pool.query("DELETE FROM whatsapp_processed_messages WHERE message_id=$1", [key]);
        console.error("No se pudo responder un mensaje entrante de WhatsApp Cloud API:", error.message, error.stack || "");
      }
    }
  }
}
async function sendWhatsAppText(to, body) {
  return whatsappBot.sendText(to, body);
}
function packageStatusLabel(status) { return ({received:"Recibido en sucursal",ready:"Listo para recoger",delivered:"Entregado",issue:"Incidencia en seguimiento"})[status] || "Actualización de paquete"; }
async function saveWhatsAppNotification(p, status, result, messageId="") {
  try {
    await pool.query(
      `INSERT INTO whatsapp_notifications(package_id,package_status,delivery_state,reason,whatsapp_message_id,next_attempt_at)
       VALUES($1,$2,$3,$4,$5,$6)`,
      [p.id,status,result.sent?"sent":result.skipped?"skipped":result.queued?"queued":"failed",result.reason||"",messageId||"",result.queued?new Date():null]
    );
  } catch(error) {
    console.error("No se pudo registrar el resultado del aviso de WhatsApp:",error.message);
  }
}
const RETRY_DELAYS_SECONDS=[60,300,900,1800,3600,7200];
async function dispatchNotification(id) {
  if(!whatsappBot.snapshot().configured)return {sent:false,queued:true,reason:"cloud_api_not_configured"};
  const claim=await pool.query(
    `UPDATE whatsapp_notifications SET delivery_state='sending',attempt_count=attempt_count+1,last_attempt_at=NOW(),reason='sending'
     WHERE id=$1 AND delivery_state='queued' AND (next_attempt_at IS NULL OR next_attempt_at<=NOW()) RETURNING attempt_count`,[id]
  );
  if(!claim.rows.length)return {sent:false,queued:true,reason:"already_processing"};
  const attempt=claim.rows[0].attempt_count;
  const {rows}=await pool.query(
    `SELECT n.id,n.package_status,p.* FROM whatsapp_notifications n JOIN packages p ON p.id=n.package_id WHERE n.id=$1`,[id]
  );
  const p=rows[0];
  if(!p)return {sent:false,skipped:true,reason:"package_deleted"};
  if(!p.whatsapp_opt_in||!p.phone){
    const reason=!p.whatsapp_opt_in?"consent_revoked":"phone_missing";
    await pool.query("UPDATE whatsapp_notifications SET delivery_state='skipped',reason=$2,next_attempt_at=NULL WHERE id=$1",[id,reason]);
    return {sent:false,skipped:true,reason};
  }
  const number=normalizeWhatsAppNumber(p.phone);
  if(!number){await pool.query("UPDATE whatsapp_notifications SET delivery_state='skipped',reason='invalid_phone',next_attempt_at=NULL WHERE id=$1",[id]);return {sent:false,skipped:true,reason:"invalid_phone"};}
  try{
    const sent=await whatsappBot.sendPackageTemplate(p.phone,{
      recipient:clean(p.recipient_name,80),folio:p.folio,tracking:p.tracking_code,
      status:packageStatusLabel(p.package_status),carrier:p.carrier
    });
    const messageId=sent?.messages?.[0]?.id||"";
    await pool.query("UPDATE whatsapp_notifications SET delivery_state='accepted',reason='meta_accepted_pending_receipt',whatsapp_message_id=$2,next_attempt_at=NULL,last_error='' WHERE id=$1",[id,messageId]);
    if(messageId){const receipt=await pool.query("SELECT status FROM whatsapp_message_receipts WHERE message_id=$1",[messageId]);if(receipt.rows[0])await handleWhatsAppCloudStatus(messageId,{0:"failed",2:"sent",3:"delivered",4:"read"}[Number(receipt.rows[0].status)]);}
    return {sent:true,accepted:true,reason:"meta_accepted_pending_receipt"};
  }catch(error){
    const terminal=attempt>=RETRY_DELAYS_SECONDS.length || error.retryable===false;
    const delay=RETRY_DELAYS_SECONDS[Math.min(attempt-1,RETRY_DELAYS_SECONDS.length-1)];
    const reason=error.retryable===false?(error.code?"meta_api_rejected":"configuration_required"):"retry_scheduled";
    await pool.query(
      `UPDATE whatsapp_notifications SET delivery_state=$2,reason=$3,next_attempt_at=$4,last_error=$5 WHERE id=$1`,
      [id,terminal?"failed":"queued",terminal?(error.retryable===false?reason:"retry_limit_reached"):reason,terminal?null:new Date(Date.now()+delay*1000),String(error.message||"Error desconocido").slice(0,500)]
    );
    const outcome=terminal?"se agotaron los reintentos":`próximo intento en ${delay}s`;
    console.error(`Aviso WhatsApp ${id} falló en intento ${attempt}; ${outcome}.`,error.message);
    return {sent:false,queued:!terminal,reason:terminal?(error.retryable===false?reason:"retry_limit_reached"):reason};
  }
}
async function dispatchQueuedNotifications(limit=5) {
  if(!whatsappBot.snapshot().configured)return 0;
  await pool.query("UPDATE whatsapp_notifications SET delivery_state='queued',next_attempt_at=NOW(),reason='recovered_stale_attempt' WHERE delivery_state='sending' AND last_attempt_at<NOW()-INTERVAL '5 minutes'");
  const {rows}=await pool.query("SELECT id FROM whatsapp_notifications WHERE delivery_state='queued' AND (next_attempt_at IS NULL OR next_attempt_at<=NOW()) ORDER BY created_at ASC LIMIT $1",[limit]);
  for(let i=0;i<rows.length;i++){
    await dispatchNotification(rows[i].id);
    if(i<rows.length-1)await new Promise(resolve=>setTimeout(resolve,1200));
  }
  return rows.length;
}
async function notifyPackage(p, status) {
  if (!p.whatsapp_opt_in) {
    const result={sent:false,skipped:true,reason:"consent_required"};
    await saveWhatsAppNotification(p,status,result);
    return result;
  }
  if (!p.phone) {
    const result={sent:false,skipped:true,reason:"phone_missing"};
    await saveWhatsAppNotification(p,status,result);
    return result;
  }
  const number=normalizeWhatsAppNumber(p.phone);
  if(!number){const result={sent:false,skipped:true,reason:"invalid_phone"};await saveWhatsAppNotification(p,status,result);return result;}
  await pool.query("UPDATE whatsapp_notifications SET delivery_state='skipped',reason='superseded_by_new_status',next_attempt_at=NULL WHERE package_id=$1 AND delivery_state='queued'",[p.id]);
  const saved=await pool.query(
    `INSERT INTO whatsapp_notifications(package_id,package_status,delivery_state,reason,whatsapp_message_id,next_attempt_at)
     VALUES($1,$2,'queued',$3,'',NOW()) RETURNING id`,[p.id,status,whatsappBot.snapshot().configured?"sending":"cloud_api_not_configured"]
  );
  return dispatchNotification(saved.rows[0].id);
}
app.post("/api/admin/packages/:id/notify", auth, adminOnly, asyncRoute(async (req,res) => {
  const { rows } = await pool.query("SELECT * FROM packages WHERE id=$1",[Number(req.params.id)]);
  const p = rows[0];
  if (!p) return res.status(404).json({error:"Paquete no encontrado."});
  if (!p.phone) return res.status(400).json({error:"Agrega el teléfono del destinatario primero."});
  if (!p.whatsapp_opt_in) return res.status(400).json({error:"Registra primero la autorización del destinatario para recibir mensajes por WhatsApp."});
  const result = await notifyPackage(p, p.status);
  if(result.queued)return res.status(202).json({ok:true,queued:true,message:"Aviso guardado en cola. Se enviará automáticamente cuando la API de Meta quede configurada."});
  if(!result.sent)return res.status(503).json({error:result.reason==="invalid_phone"?"El teléfono guardado no tiene un formato válido.":"No se pudo enviar el aviso. Revisa la conexión de WhatsApp y los reintentos en el historial."});
  res.json({ok:true,message:"WhatsApp aceptó el aviso para enviarlo. La entrega al teléfono del cliente se confirmará en el historial cuando llegue el acuse."});
}));

app.get("/api/admin/whatsapp/notifications", auth, adminOnly, asyncRoute(async (req,res) => {
  const {rows}=await pool.query(
    `SELECT n.id,n.package_status,n.delivery_state,n.reason,n.created_at,n.whatsapp_message_id,n.whatsapp_receipt_status,n.attempt_count,n.last_error,p.folio,p.tracking_code
     FROM whatsapp_notifications n JOIN packages p ON p.id=n.package_id
     ORDER BY n.created_at DESC LIMIT 25`
  );
  res.json({notifications:rows});
}));
app.post("/api/admin/whatsapp/retry-queue",auth,adminOnly,asyncRoute(async(req,res)=>{
  const configured=whatsappBot.snapshot().configured;
  if(configured)await pool.query(`WITH candidates AS (SELECT id FROM whatsapp_notifications WHERE delivery_state IN ('queued','failed') ORDER BY created_at ASC LIMIT 5) UPDATE whatsapp_notifications n SET delivery_state='queued',attempt_count=0,next_attempt_at=NOW(),reason='manual_retry' FROM candidates c WHERE n.id=c.id`);
  const processed=await dispatchQueuedNotifications(5);
  const {rows}=await pool.query("SELECT COUNT(*) FILTER(WHERE delivery_state='queued')::int AS pending,COUNT(*) FILTER(WHERE delivery_state='failed')::int AS failed FROM whatsapp_notifications");
  res.json({configured,processed,pending:rows[0].pending,failed:rows[0].failed,message:configured?`Se procesaron ${processed} avisos. Pendientes: ${rows[0].pending}; fallidos: ${rows[0].failed}.`:"WhatsApp Cloud API no está configurada. Los avisos quedan en cola hasta agregar las credenciales de Meta en Render."});
}));
app.get("/api/admin/whatsapp/status", auth, adminOnly, (req,res) => res.json({
  ...whatsappBot.snapshot(), webhookUrl:`${process.env.RENDER_EXTERNAL_URL || ""}/api/whatsapp/webhook`
}));
app.get("/api/whatsapp/webhook", (req,res) => {
  const verifyToken=process.env.WHATSAPP_VERIFY_TOKEN;
  if(!verifyToken)return res.status(503).send("Falta configurar el token de verificación de WhatsApp.");
  const mode=req.query["hub.mode"],token=req.query["hub.verify_token"],challenge=req.query["hub.challenge"];
  if(mode==="subscribe" && token===verifyToken)return res.status(200).type("text/plain").send(String(challenge||""));
  return res.sendStatus(403);
});
app.post("/api/whatsapp/webhook", asyncRoute(async (req,res) => {
  const appSecret=process.env.WHATSAPP_APP_SECRET;
  if(!appSecret)return res.status(503).json({error:"Falta configurar WHATSAPP_APP_SECRET en Render."});
  if(!verifyWhatsAppSignature(req.rawBody,req.get("x-hub-signature-256"),appSecret))return res.sendStatus(401);
  await processWhatsAppWebhook(req.body);
  res.sendStatus(200);
}));

app.get("/api/staff/session",auth,asyncRoute(async(req,res)=>{const {rows}=await pool.query("SELECT display_name,can_register_packages FROM staff_users WHERE username=$1 AND active=TRUE",[req.admin.sub]);res.json({role:req.admin.role,user:req.admin.sub,display_name:rows[0]?.display_name||req.admin.sub,can_register_packages:req.admin.role==="warehouse" && rows[0]?.can_register_packages===true});}));
app.post("/api/warehouse/scan",auth,roleOnly("warehouse"),asyncRoute(async(req,res)=>{
  const code=clean(req.body.tracking_code,120).trim();if(!code)return res.status(400).json({error:"Escanea o escribe un código de seguimiento."});
  const {rows}=await pool.query("SELECT id,folio,tracking_code,status FROM packages WHERE regexp_replace(upper(tracking_code),'[^A-Z0-9]','','g')=regexp_replace(upper($1),'[^A-Z0-9]','','g') LIMIT 1",[code]);
  if(!rows.length)return res.status(404).json({error:"No encontramos este paquete. Pide al administrador que lo registre."});
  const p=rows[0];await pool.query("INSERT INTO package_events(package_id,event,detail) VALUES($1,'warehouse_scan',$2)",[p.id,`Escaneo de almacén por ${req.admin.sub}`]);
  res.json({package:{folio:p.folio,tracking_code:p.tracking_code,status:p.status},message:"Escaneo registrado en almacén."});
}));
app.post("/api/warehouse/packages",auth,warehouseRegisterOnly,asyncRoute(async(req,res)=>{
  const tracking=clean(req.body.tracking_code,120);
  if(!tracking)return res.status(400).json({error:"El código de seguimiento es obligatorio."});
  const recipient=clean(req.body.recipient_name,120),address=clean(req.body.recipient_address,300);
  const phone=normalizePhone(req.body.phone),carrier=clean(req.body.carrier||"Mercado Libre",60),notes=clean(req.body.notes,500);
  const whatsappOptIn=req.body.whatsapp_opt_in===true,folio=makeFolio();
  try{
    const client=await pool.connect();let rows;
    try{
      await client.query("BEGIN");
      ({rows}=await client.query(`INSERT INTO packages(tracking_code,folio,recipient_name,phone,recipient_address,carrier,notes,whatsapp_opt_in,status)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,'received') RETURNING *`,
      [tracking,folio,recipient,phone,address,carrier,notes,whatsappOptIn]));
      await client.query("INSERT INTO package_events(package_id,event,detail) VALUES($1,'received',$2)",[rows[0].id,`Paquete registrado por almacén: ${req.admin.sub}`]);
      await client.query("COMMIT");
    }catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();}
    const notification=await notifyPackage(rows[0],"received");
    res.status(201).json({package:rows[0],notification,message:"Paquete registrado correctamente en almacén."});
  }catch(error){
    if(error.code==="23505")return res.status(409).json({error:"Ese número de seguimiento ya está registrado."});
    throw error;
  }
}));
app.get("/api/courier/deliveries",auth,roleOnly("courier"),asyncRoute(async(req,res)=>{const {rows}=await pool.query("SELECT id,folio,tracking_code,recipient_name,phone,recipient_address,carrier,status FROM packages WHERE status='ready' ORDER BY updated_at ASC LIMIT 200");res.json({deliveries:rows});}));
app.post("/api/courier/deliveries/:id/complete",auth,roleOnly("courier"),asyncRoute(async(req,res)=>{
  const id=Number(req.params.id);if(!Number.isSafeInteger(id))return res.status(400).json({error:"Entrega no válida."});
  const client=await pool.connect();let rows;try{await client.query("BEGIN");({rows}=await client.query("UPDATE packages SET status='delivered',delivered_at=NOW(),updated_at=NOW() WHERE id=$1 AND status='ready' RETURNING *",[id]));if(!rows[0]){await client.query("ROLLBACK");return res.status(409).json({error:"La entrega ya no está disponible o cambió de estado."});}await client.query("INSERT INTO package_events(package_id,event,detail) VALUES($1,'delivered',$2)",[id,`Entrega confirmada por repartidor ${req.admin.sub}`]);await client.query("COMMIT");}catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();}
  const notification=await notifyPackage(rows[0],"delivered");res.json({ok:true,notification});
}));

function whatsappHelpText() {
  return "¡Hola! Soy el asistente de LOBO TELECOM 📦\n\nPara consultar tu paquete, envíame tu folio LOBO o número de seguimiento desde este mismo teléfono.\nEjemplo: LT-261114-ABC123\nTambién puedes escribir: Folio: LT-261114-ABC123 o Guía: ABC123456789.\n\nEscribe AYUDA para ver estas instrucciones.";
}
function normalizeWhatsAppReference(text) {
  const raw=clean(text,180).toUpperCase();
  const lobo=raw.match(/\bLT[\s-]?\d{6}[\s-]?[A-Z0-9]{6}\b/);
  if(lobo)return lobo[0].replace(/[^A-Z0-9]/g,"");
  const labeled=raw.match(/(?:FOLIO|GU[IÍ]A|SEGUIMIENTO|TRACKING|C[ÓO]DIGO)\s*(?:(?:ES|N[ÚU]MERO|NUMERO|NO\.?|:|#)\s*)?([A-Z0-9][A-Z0-9-]{4,59})/);
  if(labeled)return labeled[1].replace(/[^A-Z0-9]/g,"");
  return raw.replace(/[^A-Z0-9]/g,"");
}
async function handleIncomingWhatsAppMessage(jid, senderPhone, text, alternateJid="") {
  const reply = async body => {
    try { return await sendWhatsAppText(jid, body); }
    catch (error) {
      if (alternateJid && alternateJid !== jid && /No sessions/i.test(error.message || "")) return sendWhatsAppText(alternateJid, body);
      throw error;
    }
  };
  const reference = normalizeWhatsAppReference(text);
  if (!reference || /^(HOLA|BUENAS|AYUDA|MENU|INFO|INICIO|START|ESTADO|CONSULTAR|RASTREAR|PAQUETE|FOLIO|GUIA|SEGUIMIENTO|TRACKING)$/i.test(reference)) {
    return reply(whatsappHelpText());
  }
  const { rows } = await pool.query(
    `SELECT folio,tracking_code,carrier,status,received_at FROM packages
     WHERE right(regexp_replace(phone, '[^0-9]', '', 'g'),10)=right(regexp_replace($1, '[^0-9]', '', 'g'),10)
       AND (regexp_replace(upper(folio), '[^A-Z0-9]', '', 'g')=$2
         OR regexp_replace(upper(tracking_code), '[^A-Z0-9]', '', 'g')=$2)
     ORDER BY created_at DESC LIMIT 1`, [normalizePhone(senderPhone), reference]
  );
  if (!rows.length) return reply(
    "No pude hacer coincidir el folio o la guía con el teléfono desde el que escribes. Envía solo el folio o número de seguimiento y verifica que el paquete tenga registrado este mismo número de WhatsApp. Por privacidad no puedo mostrar paquetes asociados a otro teléfono.");
  const p=rows[0];
  const state=p.status==="ready" ? "está listo para recoger" : p.status==="delivered" ? "ya fue entregado" : p.status==="issue" ? "tiene una incidencia; nuestro equipo dará seguimiento" : "fue recibido en LOBO TELECOM";
  const date=new Intl.DateTimeFormat("es-MX",{dateStyle:"medium",timeZone:"America/Chihuahua"}).format(new Date(p.received_at));
  return reply(`🐺 *LOBO TELECOM*\n_Atención VIP · Seguimiento personalizado_\n\nTu paquete ${state}.\n\n📦 *Folio:* ${p.folio}\n🔎 *Guía:* ${p.tracking_code}\n🚚 *Paquetería:* ${p.carrier}\n🗓️ *Recibido:* ${date}\n\n_Gracias por confiar en LOBO TELECOM._`);
}

app.use((err,req,res,next) => {
  if (err.message === "Origen no permitido por CORS") return res.status(403).json({ error: "Origen no permitido." });
  console.error(err);
  res.status(500).json({error:"Error interno del servidor."});
});
const port = Number(process.env.PORT || 3000);
dbInit().then(() => {
  app.listen(port, () => console.log(`LOBO TELECOM activo en puerto ${port}`));
  const retryTimer=setInterval(()=>dispatchQueuedNotifications().catch(error=>console.error("No se pudo procesar la cola de WhatsApp:",error.message)),15000);
  retryTimer.unref();
}).catch(err => { console.error("No se pudo iniciar la base de datos:",err); process.exit(1); });



