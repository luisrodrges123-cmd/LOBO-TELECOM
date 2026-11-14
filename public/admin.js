const $ = s => document.querySelector(s);
let token=localStorage.getItem("lobo_admin_token")||"";
let scanner=null, scanning=false, packages=[];
const headers=()=>({"Content-Type":"application/json","Authorization":`Bearer ${token}`});
function message(el,text,error=false){el.textContent=text;el.className="result "+(error?"error":"success");}
function showDashboard(){ $("#loginView").hidden=true; $("#dashboard").hidden=false; loadPackages(); loadWhatsAppStatus(); }
if(token) showDashboard();
$("#loginForm").addEventListener("submit",async e=>{
 e.preventDefault(); const out=$("#loginMsg"); message(out,"Validando acceso...");
 try{const r=await fetch("/api/admin/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({username:$("#username").value,password:$("#password").value})});const d=await r.json();if(!r.ok)throw Error(d.error);token=d.token;localStorage.setItem("lobo_admin_token",token);showDashboard();}
 catch(err){message(out,err.message,true);}
});
$("#logoutBtn").onclick=()=>{localStorage.removeItem("lobo_admin_token");token="";$("#dashboard").hidden=true;$("#loginView").hidden=false;};
async function api(url,opts={}){const r=await fetch(url,{...opts,headers:{...headers(),...(opts.headers||{})}});const d=await r.json();if(r.status===401){$("#logoutBtn").click();throw Error("Tu sesión expiró.");}if(!r.ok)throw Error(d.error||"Error en la solicitud.");return d;}
let waPollTimer=null;
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
 $("#packageList").innerHTML=packages.length?packages.map(p=>`<article class="package-item"><div class="package-top"><div><div class="package-code">${esc(p.folio)}</div><div class="package-meta">${esc(p.tracking_code)}</div></div><span class="status ${p.status}">${labels[p.status]||p.status}</span></div><div class="package-meta">${esc(p.recipient_name||"Destinatario pendiente")} · ${esc(p.phone||"Sin teléfono")}<br>${esc(p.carrier)} · ${new Date(p.received_at).toLocaleString("es-MX")}</div><div class="item-actions"><select aria-label="Cambiar estado" data-status="${p.id}">${Object.entries(labels).map(([v,l])=>`<option value="${v}" ${p.status===v?"selected":""}>${l}</option>`).join("")}</select><button class="btn btn-ghost" data-save="${p.id}">Guardar estado</button><button class="btn btn-ghost" data-notify="${p.id}">Avisar WhatsApp</button></div></article>`).join(""):'<div class="empty">No hay paquetes que coincidan con la búsqueda.</div>';
}
function esc(s){return String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}
$("#packageForm").addEventListener("submit",async e=>{
 e.preventDefault();const out=$("#saveMsg");message(out,"Guardando paquete...");
 try{const d=await api("/api/admin/packages",{method:"POST",body:JSON.stringify({tracking_code:$("#tracking").value,recipient_name:$("#recipient").value,phone:$("#phone").value,carrier:$("#carrier").value,notes:$("#notes").value,whatsapp_opt_in:$("#whatsappOptIn").checked})});const note=d.notification?.sent?" Aviso de WhatsApp enviado.":d.notification?.reason==="whatsapp_not_connected"?" Conecta WhatsApp con el QR para enviar avisos.":"";message(out,`Paquete guardado. Folio generado: ${d.package.folio}.${note}`);$("#packageForm").reset();await loadPackages();}
 catch(err){message(out,err.message,true);}
});
$("#packageList").addEventListener("click",async e=>{
 const save=e.target.closest("[data-save]"),notify=e.target.closest("[data-notify]");
 try{
  if(save){const id=save.dataset.save,status=document.querySelector(`[data-status="${id}"]`).value;await api(`/api/admin/packages/${id}`,{method:"PATCH",body:JSON.stringify({status})});await loadPackages();}
  if(notify){const d=await api(`/api/admin/packages/${notify.dataset.notify}/notify`,{method:"POST",body:"{}"});alert(d.message);}
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
