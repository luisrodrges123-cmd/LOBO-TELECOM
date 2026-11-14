const $ = s => document.querySelector(s);
$("#year").textContent = new Date().getFullYear();
$("#lookupType").addEventListener("change", () => {
  const folio = $("#lookupType").value === "folio";
  $("#valueLabel").firstChild.textContent = folio ? "Folio LOBO TELECOM" : "Número de seguimiento";
  $("#lookupValue").placeholder = folio ? "Ej. LT-261114-ABC123" : "Código de la etiqueta";
});
$("#lookupForm").addEventListener("submit", async e => {
  e.preventDefault();
  const out=$("#lookupResult"); out.className="result"; out.textContent="Consultando...";
  const isFolio=$("#lookupType").value==="folio";
  try {
    const r=await fetch("/api/lookup",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({
      [isFolio?"folio":"tracking_code"]:$("#lookupValue").value.trim(),
      phone:$("#lookupPhone").value.trim()
    })});
    const data=await r.json(); if(!r.ok) throw new Error(data.error||"No fue posible consultar.");
    const p=data.package;
    const states={received:"Recibido en LOBO TELECOM",ready:"Listo para recoger",delivered:"Entregado",issue:"Requiere atención"};
    out.className="result success";
    out.innerHTML=`<div class="package-item"><div class="package-top"><b>${states[p.status]||p.status}</b><span class="status ${p.status}">${p.carrier}</span></div><div class="package-meta">Folio: <b>${escapeHtml(p.folio)}</b><br>Seguimiento: ${escapeHtml(p.tracking_code)}<br>Recibido: ${new Date(p.received_at).toLocaleString("es-MX")}${p.delivered_at?`<br>Entregado: ${new Date(p.delivered_at).toLocaleString("es-MX")}`:""}</div></div>`;
  } catch(err){out.className="result error";out.textContent=err.message;}
});
function escapeHtml(s){return String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}
