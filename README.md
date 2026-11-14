# LOBO TELECOM — Sistema de control de paquetería

Proyecto inicial profesional para recibir, registrar, consultar y entregar paquetes desde LOBO TELECOM.

## Incluye
- Portal público de consulta por folio o seguimiento + teléfono registrado.
- Panel privado con login.
- Alta manual o escaneo de QR/código de barras desde cámara del celular.
- Folio LOBO automático.
- Estados: recibido, listo para recoger, entregado e incidencia.
- PostgreSQL persistente.
- Notificaciones de WhatsApp Cloud API al registrar y cambiar el estado, cuando se registra consentimiento.

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
## WhatsApp
Este proyecto usa WhatsApp Cloud API. Para activarlo:
1. Crea/configura una app en Meta for Developers y agrega WhatsApp.
2. Verifica el negocio y registra un número compatible.
3. Copia el token de acceso y Phone Number ID a `WHATSAPP_TOKEN` y `WHATSAPP_PHONE_NUMBER_ID`. Crea y aprueba la plantilla `package_status` en español con dos variables en el cuerpo: folio y estado; configura `WHATSAPP_TEMPLATE_NAME` y `WHATSAPP_TEMPLATE_LANGUAGE` para que coincidan.
4. En Meta configura el webhook en `https://TU-DOMINIO/api/whatsapp/webhook`, con `WHATSAPP_VERIFY_TOKEN`, y suscríbete al evento `messages`. Agrega también `WHATSAPP_APP_SECRET` (App Secret de Meta) como variable privada para validar la firma de cada evento.
5. El bot oficial responde al folio o número de guía que el cliente envíe desde el mismo teléfono registrado. También contesta saludos con instrucciones; limita los resultados al estado, folio y guía del cliente.
6. El panel de administración muestra el estado de configuración y la URL del webhook. Esta conexión oficial se configura con credenciales de Meta; no se vincula por QR.
7. Para notificaciones iniciadas por el negocio fuera de la ventana de atención de 24 horas, Meta exige plantillas aprobadas. El envío de texto libre puede ser rechazado por Meta.
8. El destinatario debe haber dado consentimiento para recibir mensajes.

## Seguridad / pendientes antes de producción
- El servidor no inicia si `JWT_SECRET` es menor de 32 caracteres o si falta `ADMIN_PASSWORD`.
- Los avisos automáticos requieren consentimiento registrado, credenciales válidas de Meta y una plantilla aprobada compatible.
- Genera credenciales únicas y guárdalas únicamente como variables privadas del entorno. No subas `.env`.
- Activa HTTPS.
- Añade políticas de privacidad, aviso de tratamiento de datos y consentimiento.
- Limita el acceso al panel y protege físicamente los paquetes.
- Configura respaldo automático de PostgreSQL.
- Implementa un flujo de confirmación de entrega (PIN/firma/identificación) antes de operar a escala.
- El webhook valida la firma con `WHATSAPP_APP_SECRET`, evita procesar dos veces el mismo mensaje y responde consultas entrantes de WhatsApp por folio o seguimiento, verificando el teléfono remitente.
- No publiques ni compartas datos personales de destinatarios.

## Cambios de esta versión
- Los cambios de estado ya no borran los datos opcionales del destinatario.
- El historial y los cambios del paquete se guardan en una misma transacción.
- Las credenciales administrativas se comparan en tiempo constante.
- La política de seguridad del navegador permite cargar el lector QR desde unpkg.
- Los avisos automáticos y manuales usan una plantilla aprobada de WhatsApp.
