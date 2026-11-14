const $ = s => document.querySelector(s);
let token=localStorage.getItem("lobo_admin_token")||"";
let scanner=null, scanning=false, packages=[];
const headers=()=>({"Content-Type":"application/json","Authorization":`Bearer ${token}`});
function message(el,text,error=false){el.textContent=text;el.className="result "+(error?"error":"success");}
function notificationNote(n){if(!n)return"";if(n.sent)return" Aviso de WhatsApp enviado.";if(n.queued)return" Aviso guardado en cola; se enviará al reconectar WhatsApp.";if(n.reason==="consent_required")return" No se envió WhatsApp: falta autorización del cliente.";if(n.reason==="phone_missing")return" No se envió WhatsApp: falta el teléfono del cliente.";if(n.reason==="whatsapp_not_connected")return" Conecta WhatsApp con el QR para enviar el aviso.";if(n.reason==="invalid_phone")return" No se pudo enviar: el teléfono no es válido.";if(n.reason==="whatsapp_send_failed")return" El aviso no salió; revisa la conexión y consulta el historial.";return"";}
async function showDashboard(){ try{const session=await api("/api/staff/session");if(session.role!=="admin"){location.replace("/staff.html");return;} $("#loginView").hidden=true; $("#dashboard").hidden=false; loadPackages(); loadWhatsAppStatus(); loadWhatsAppHistory(); loadStaffUsers();}catch(e){if(token)$("#loginMsg").textContent=e.message;} }
if(token) showDashboard();
$("#loginForm").addEventListener("submit",async e=>{
 e.preventDefault(); const out=$("#loginMsg"); message(out,"Validando acceso...");
 try{const r=await fetch("/api/admin/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({username:$("#username").value,password:$("#password").value})});const d=await r.json();if(!r.ok)throw Error(d.error);token=d.token;localStorage.setItem("lobo_admin_token",token);if(d.role!=="admin"){location.href="/staff.html";return;}showDashboard();}
 catch(err){message(out,err.message,true);}
});
$("#logoutBtn").onclick=()=>{localStorage.removeItem("lobo_admin_token");token="";$("#dashboard").hidden=true;$("#loginView").hidden=false;};
async function api(url,opts={}){const r=await fetch(url,{...opts,headers:{...headers(),...(opts.headers||{})}});const d=await r.json();if(r.status===401){$("#logoutBtn").click();throw Error("Tu sesión expiró.");}if(!r.ok)throw Error(d.error||"Error en la solicitud.");return d;}
let waPollTimer=null;
async function loadWhatsAppHistory(){
 try{
  const d=await api("/api/admin/whatsapp/notifications"),list=$("#waNotificationHistory");
  const states={sent:"Enviado",failed:"Falló",skipped:"Omitido",queued:"En cola",sending:"Enviando"};
  const reasons={consent_required:"Sin autorización del cliente",phone_missing:"Falta el teléfono",invalid_phone:"Teléfono no válido",whatsapp_offline_wait:"Esperando conexión QR",retry_scheduled:"Reintento programado",retry_limit_reached:"Requiere revisión manual",manual_retry:"Reintento manual",superseded_by_new_status:"Reemplazado por un estado más reciente",recovered_stale_attempt:"Reintento recuperado tras reinicio",sending:"Envío en curso",sent:"Enviado a WhatsApp"};
  list.innerHTML=d.notifications.length?d.notifications.map(n=>`<article class="wa-history-item"><div class="wa-history-icon ${esc(n.delivery_state)}">${n.delivery_state==="sent"?"✓":n.delivery_state==="queued"?"↻":n.delivery_state==="sending"?"…":n.delivery_state==="skipped"?"–":"!"}</div><div class="wa-history-copy"><strong>${esc(n.folio)} · ${esc(n.tracking_code)}</strong><span>${esc(labelsForStatus(n.package_status))} · ${esc(reasons[n.reason]||n.reason||"")}</span></div><div class="wa-history-meta"><b class="wa-state-${esc(n.delivery_state)}">${states[n.delivery_state]||n.delivery_state}</b><time>${new Date(n.created_at).toLocaleString("es-MX")}</time></div></article>`).join(""):'<div class="wa-history-empty">Aún no hay avisos registrados.</div>';
 }catch(e){$("#waNotificationHistory").innerHTML=`<div class="wa-history-empty">${esc(e.message)}</div>`;}
}
function labelsForStatus(status){return({received:"Recibido",ready:"Listo para recoger",delivered:"Entregado",issue:"Incidencia"})[status]||status;}
async function loadWhatsAppStatus(){
 try{
  const d=await api("/api/admin/whatsapp/status"),badge=$("#botBadge"),status=$("#botStatus"),qr=$("#botQr"),placeholder=$("#botQrPlaceholder"),connect=$("#connectWhatsapp"),disconnect=$("#disconnectWhatsapp");
  badge.textContent=d.state==="connected"?"Conectado":d.state==="qr"?"Esperando escaneo":d.state==="connecting"||d.state==="reconnecting"?"Conectando…":d.state==="error"?"Revisar configuración":"Desconectado";
  badge.classList.toggle("bot-ready",d.state==="connected");
  status.textContent=d.configured?(d.message||""):"Falta la llave privada de cifrado en Render. Agrégala para habilitar la conexión QR.";
  if(d.phone&&d.state==="connected")status.textContent=`Conectado al número terminado en ${d.phone.slice(-4)}. El bot está listo para responder consultas.`;
  if(d.qr){qr.src=d.qr;qr.hidden=false;placeholder.hidden=true;}else{qr.removeAttribute("src");qr.hidden=true;placeholder.hidden=false;}
  connect.disabled=!d.configured||["connecting","reconnecting"].includes(d.state);
  connect.textContent=d.state==="qr"?"Actualizar QR":d.state==="connected"?"Conectado":"Generar QR";
  disconnect.hidden=d.state==="disconnected"||d.state==="error";
  if(waPollTimer)clearTimeout(waPollTimer);
  if(["qr","connecting","reconnecting"].includes(d.state))waPollTimer=setTimeout(loadWhatsAppStatus,2000);
 }catch(e){$("#botStatus").textContent=e.message;}
}
$("#refreshWaHistory").onclick=loadWhatsAppHistory;
$("#retryWaQueue").addEventListener("click",async()=>{const button=$("#retryWaQueue");button.disabled=true;try{const d=await api("/api/admin/whatsapp/retry-queue",{method:"POST",body:"{}"});message($("#botStatus"),d.message,!d.connected);await loadWhatsAppHistory();}catch(e){message($("#botStatus"),e.message,true);}finally{button.disabled=false;}});
$("#connectWhatsapp").addEventListener("click",async()=>{
 const button=$("#connectWhatsapp");button.disabled=true;message($("#botStatus"),"Preparando la conexión segura con WhatsApp…");
 try{await api("/api/admin/whatsapp/connect",{method:"POST",body:"{}"});await loadWhatsAppStatus();}
 catch(e){message($("#botStatus"),e.message,true);button.disabled=false;}
});
$("#disconnectWhatsapp").addEventListener("click",async()=>{
 if(!confirm("¿Desconectar WhatsApp y borrar la sesión vinculada del servidor?"))return;
 try{await api("/api/admin/whatsapp/disconnect",{method:"POST",body:"{}"});await loadWhatsAppStatus();}
 catch(e){message($("#botStatus"),e.message,true);}
});
async function loadPackages(){
 try{const q=encodeURIComponent($("#search").value||""),s=encodeURIComponent($("#statusFilter").value||"");const d=await api(`/api/admin/packages?q=${q}&status=${s}`);packages=d.packages;render();}
 catch(e){$("#packageList").innerHTML=`<div class="empty">${e.message}</div>`;}
}
function render(){
 const count=s=>packages.filter(p=>p.status===s).length;
 $("#statTotal").textContent=packages.length;$("#statReceived").textContent=count("received");$("#statReady").textContent=count("ready");$("#statDelivered").textContent=count("delivered");
 const labels={received:"Recibido",ready:"Listo para recoger",delivered:"Entregado",issue:"Incidencia"};
 $("#packageList").innerHTML=packages.length?packages.map(p=>`<article class="package-item"><div class="package-top"><div><div class="package-code">${esc(p.folio)}</div><div class="package-meta">${esc(p.tracking_code)}</div></div><span class="status ${p.status}">${labels[p.status]||p.status}</span></div><div class="package-meta">${esc(p.recipient_name||"Destinatario pendiente")} · ${esc(p.phone||"Sin teléfono")}<br>${esc(p.recipient_address||"Sin dirección de entrega")}<br>${esc(p.carrier)} · ${new Date(p.received_at).toLocaleString("es-MX")}</div><details class="delivery-edit"><summary>Editar datos del destinatario y dirección</summary><form data-delivery-edit="${p.id}" class="delivery-edit-form"><label>Nombre<input name="recipient_name" value="${esc(p.recipient_name||"")}" maxlength="120"></label><label>Teléfono<input name="phone" value="${esc(p.phone||"")}" inputmode="tel" maxlength="25"></label><label>Dirección o link de Google Maps<input name="recipient_address" value="${esc(p.recipient_address||"")}" maxlength="300"></label><button class="btn btn-ghost">Guardar datos</button></form></details><div class="item-actions"><select aria-label="Cambiar estado" data-status="${p.id}">${Object.entries(labels).map(([v,l])=>`<option value="${v}" ${p.status===v?"selected":""}>${l}</option>`).join("")}</select><button class="btn btn-ghost" data-save="${p.id}">Guardar estado</button><button class="btn btn-ghost" data-notify="${p.id}">Avisar WhatsApp</button><button class="btn btn-danger" data-delete-package="${p.id}">Eliminar</button></div></article>`).join(""):'<div class="empty">No hay paquetes que coincidan con la búsqueda.</div>';
}
function esc(s){return String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}
$("#packageForm").addEventListener("submit",async e=>{
 e.preventDefault();const out=$("#saveMsg");message(out,"Guardando paquete...");
 try{const d=await api("/api/admin/packages",{method:"POST",body:JSON.stringify({tracking_code:$("#tracking").value,recipient_name:$("#recipient").value,phone:$("#phone").value,recipient_address:$("#address").value,carrier:$("#carrier").value,notes:$("#notes").value,whatsapp_opt_in:$("#whatsappOptIn").checked})});const note=notificationNote(d.notification);message(out,`Paquete guardado. Folio generado: ${d.package.folio}.${note}`);$("#packageForm").reset();await loadPackages();await loadWhatsAppHistory();}
 catch(err){message(out,err.message,true);}
});
$("#packageList").addEventListener("submit",async e=>{const form=e.target.closest("[data-delivery-edit]");if(!form)return;e.preventDefault();const p=packages.find(x=>String(x.id)===form.dataset.deliveryEdit);if(!p)return;try{await api(`/api/admin/packages/${p.id}`,{method:"PATCH",body:JSON.stringify({status:p.status,recipient_name:form.elements.recipient_name.value,phone:form.elements.phone.value,recipient_address:form.elements.recipient_address.value})});message($("#saveMsg"),"Datos de entrega actualizados.");await loadPackages();}catch(err){message($("#saveMsg"),err.message,true);}});
$("#packageList").addEventListener("click",async e=>{
 const save=e.target.closest("[data-save]"),notify=e.target.closest("[data-notify]"),remove=e.target.closest("[data-delete-package]");
 try{
  if(remove){const p=packages.find(x=>String(x.id)===remove.dataset.deletePackage);if(!p||!confirm(`¿Eliminar permanentemente el paquete ${p.folio}? También se borrará su historial y registro de avisos.`))return;await api(`/api/admin/packages/${p.id}`,{method:"DELETE"});await loadPackages();await loadWhatsAppHistory();message($("#saveMsg"),`Paquete ${p.folio} eliminado.`);}
  if(save){const id=save.dataset.save,status=document.querySelector(`[data-status="${id}"]`).value;const d=await api(`/api/admin/packages/${id}`,{method:"PATCH",body:JSON.stringify({status})});await loadPackages();await loadWhatsAppHistory();const note=notificationNote(d.notification);message($("#saveMsg"),`Estado actualizado.${note}`);}
  if(notify){const d=await api(`/api/admin/packages/${notify.dataset.notify}/notify`,{method:"POST",body:"{}"});alert(d.message);await loadWhatsAppHistory();}
 }catch(err){alert(err.message);}
});
$("#refreshBtn").onclick=loadPackages;$("#search").addEventListener("input",debounce(loadPackages,350));$("#statusFilter").onchange=loadPackages;
function debounce(fn,ms){let t;return(...a)=>{clearTimeout(t);t=setTimeout(()=>fn(...a),ms);}}
$("#startScan").onclick=async()=>{
 if(!window.Html5Qrcode){alert("No se cargó el lector. Revisa tu conexión.");return;}
 if(scanning)return;
 try{
  scanner=new Html5Qrcode("reader");
  const config={fps:10,qrbox:{width:240,height:160},rememberLastUsedCamera:true};
  await scanner.start({facingMode:"environment"},config,async decoded=>{
    $("#tracking").value=decoded.trim();
    if(navigator.vibrate)navigator.vibrate(100);
    await stopScanner();
    $("#recipient").focus();
  },()=>{});
  scanning=true;
 }catch(e){alert("No se pudo abrir la cámara. Permite el acceso a la cámara y usa HTTPS.");}
};
async function stopScanner(){if(scanner&&scanning){try{await scanner.stop();await scanner.clear();}catch{}scanning=false;}}
$("#stopScan").onclick=stopScanner;
$("#tracking").addEventListener("paste",()=>setTimeout(()=>$("#recipient").focus(),50));

async function loadStaffUsers(){
 try{const d=await api("/api/admin/users");const list=$("#staffUserList");list.innerHTML=d.users.length?d.users.map(u=>`<article class="staff-user-row"><strong>${esc(u.display_name)}</strong><span>${esc(u.username)}</span><span class="pill">${u.role==="warehouse"?"Almacén":"Repartidor"}</span><span>${u.active?"Activo":"Inactivo"}</span><button class="btn btn-danger" data-delete-user="${u.id}" data-username="${esc(u.username)}">Eliminar usuario</button></article>`).join(""):'<p class="tiny">Aún no hay usuarios adicionales.</p>';}
 catch(e){$("#staffUserList").textContent=e.message;}
}
$("#userForm").addEventListener("submit",async e=>{e.preventDefault();const out=$("#userMsg");message(out,"Creando acceso…");try{await api("/api/admin/users",{method:"POST",body:JSON.stringify({display_name:$("#staffName").value,username:$("#staffUsername").value,role:$("#staffRole").value,password:$("#staffPassword").value})});$("#userForm").reset();message(out,"Usuario creado. Comparte las credenciales de forma segura.");await loadStaffUsers();}catch(err){message(out,err.message,true);}});

$("#staffUserList").addEventListener("click",async e=>{const b=e.target.closest("[data-delete-user]");if(!b)return;const name=b.dataset.username;if(!confirm(`¿Eliminar el acceso de ${name}? Su sesión también quedará invalidada.`))return;b.disabled=true;try{await api(`/api/admin/users/${b.dataset.deleteUser}`,{method:"DELETE"});message($("#userMsg"),`Acceso de ${name} eliminado.`);await loadStaffUsers();}catch(err){message($("#userMsg"),err.message,true);b.disabled=false;}});
