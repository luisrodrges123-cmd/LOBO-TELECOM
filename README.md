# LOBO TELECOM — Sistema de control de paquetería

Proyecto inicial profesional para recibir, registrar, consultar y entregar paquetes desde LOBO TELECOM.

## Incluye
- Portal público de consulta por folio o seguimiento + teléfono registrado.
- Panel privado con login.
- Alta manual o escaneo de QR/código de barras desde cámara del celular.
- Folio LOBO automático.
- Estados: recibido, listo para recoger, entregado e incidencia.
- PostgreSQL persistente.
- Asistente de WhatsApp Web vinculado desde el panel mediante QR, además de avisos de paquetes cuando el destinatario dio consentimiento.

## Importante sobre el escáner
El lector extrae el contenido del QR/código de barras de la etiqueta. No consulta automáticamente la base privada de Mercado Libre. El paquete queda registrado con su código; el administrador completa nombre y teléfono del destinatario. Para importar datos directamente de Mercado Libre se requiere acceso/integración autorizada.

## Requisitos
- Node.js 20 o superior.
- PostgreSQL (por ejemplo, Render PostgreSQL).
- HTTPS para usar la cámara desde el celular (localhost también funciona).

## Instalación local
1. Descomprime el ZIP.
2. Abre una terminal en la carpeta.
3. Ejecuta `npm install`.
4. Copia `.env.example` a `.env`.
5. Completa `DATABASE_URL`, `JWT_SECRET`, `ADMIN_USER=Angelito` y `ADMIN_PASSWORD` (configura la contraseña solo como variable privada; no la subas a GitHub).
6. Ejecuta `npm start`.
7. Abre `http://localhost:3000` y el panel en `/admin.html`.

No uses la contraseña de ejemplo. Genera un `JWT_SECRET` largo y único. No subas `.env` a GitHub.

## Despliegue gratuito en Render con Neon
- Crea un proyecto PostgreSQL gratuito en Neon y copia la cadena de conexión pooled.
- Usa el Blueprint `render.yaml` para desplegar el Web Service gratuito conectado a este repositorio.
- Configura `DATABASE_URL` con la cadena de Neon en Render. No la subas a GitHub.
- Render genera `JWT_SECRET` y `ADMIN_PASSWORD` de forma segura. Consulta la contraseña en Environment en el panel de Render; el usuario es `Angelito`.
- `DATABASE_SSL=true` está configurado en el Blueprint.
- Render gratuito puede suspender la web tras inactividad; Neon Free tiene límites mensuales y puede suspender conexiones al agotarlos.
## Bot de WhatsApp por QR
Este proyecto usa Baileys para vincular una sesión de WhatsApp Web desde el administrador; no utiliza Meta Cloud API.
1. En Render, configura `WHATSAPP_SESSION_ENCRYPTION_KEY` con una llave aleatoria de 32 bytes codificada en base64. No la subas al repositorio ni la compartas. Si cambias esta llave, la sesión guardada no podrá descifrarse y tendrás que volver a vincular el dispositivo.
2. Abre `/admin.html`, inicia sesión y pulsa **Generar QR**.
3. En el teléfono del negocio, abre WhatsApp → **Dispositivos vinculados** → **Vincular un dispositivo** y escanea el QR que aparece en el panel.
4. El panel muestra el estado de conexión. El bot responde consultas por folio o número de seguimiento, solo si el remitente coincide con el teléfono registrado. Los avisos salientes de paquetes siguen requiriendo consentimiento del destinatario.
5. La sesión y sus claves se guardan cifradas con AES-256-GCM en PostgreSQL, para no depender del disco temporal del hosting.
6. Al recibir un paquete o cambiarlo a listo, entregado o incidencia, el bot envía un aviso personalizado. El panel registra los envíos, los omitidos por falta de consentimiento y los fallidos para facilitar el seguimiento.

**Limitaciones:** Baileys es una librería comunitaria, no oficial de WhatsApp ni de Meta. Úsala bajo tu propio criterio, evita mensajes masivos y considera el riesgo de desconexiones o restricciones del número. Render gratuito puede suspender el servicio por inactividad; el bot intentará reconectar al despertar, pero puede tardar. Para operación crítica o comercial a escala, usa la API oficial de WhatsApp Business.

## Seguridad / pendientes antes de producción
- El servidor no inicia si `JWT_SECRET` es menor de 32 caracteres o si falta `ADMIN_PASSWORD`.
- Los avisos automáticos requieren consentimiento registrado, credenciales válidas de Meta y una plantilla aprobada compatible.
- Genera credenciales únicas y guárdalas únicamente como variables privadas del entorno. No subas `.env`.
- Activa HTTPS.
- Añade políticas de privacidad, aviso de tratamiento de datos y consentimiento.
- Limita el acceso al panel y protege físicamente los paquetes.
- Configura respaldo automático de PostgreSQL.
- Implementa un flujo de confirmación de entrega (PIN/firma/identificación) antes de operar a escala.
- Los mensajes entrantes se procesan una sola vez y las consultas comparan la guía/folio junto con el teléfono de WhatsApp del remitente.
- No publiques ni compartas datos personales de destinatarios.

## Cambios de esta versión
- Los cambios de estado ya no borran los datos opcionales del destinatario.
- El historial y los cambios del paquete se guardan en una misma transacción.
- Las credenciales administrativas se comparan en tiempo constante.
- La política de seguridad del navegador permite cargar el lector QR desde unpkg.
- El panel administrativo permite vincular y desconectar el bot con QR; las credenciales de sesión se cifran en PostgreSQL.
