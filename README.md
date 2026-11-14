# LOBO TELECOM — Sistema de control de paquetería

Proyecto inicial profesional para recibir, registrar, consultar y entregar paquetes desde LOBO TELECOM.

## Incluye
- Portal público de consulta por folio o seguimiento + teléfono registrado.
- Panel privado con login.
- Alta manual o escaneo de QR/código de barras desde cámara del celular.
- Folio LOBO automático.
- Estados: recibido, listo para recoger, entregado e incidencia.
- PostgreSQL persistente.
- Envío y respuestas mediante WhatsApp Business Cloud API oficial, con webhooks de Meta y autorización registrada del destinatario.

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
## WhatsApp Business Cloud API oficial
Este proyecto usa la API oficial alojada por Meta. Ya no se vincula WhatsApp por QR ni usa Baileys. Para activar envíos y respuestas:

1. En Meta for Developers, configura WhatsApp Business Platform y un número de teléfono registrado para Cloud API.
2. La plantilla `3p_direct_integration_test_template` compartida desde Meta se validó como prueba simple; no incluye datos de paquete y el sistema bloquea su uso como plantilla de avisos. Para avisos reales, crea y aprueba una plantilla de utilidad como `lobo_estado_paquete` (o define su nombre en Render) con cinco variables de cuerpo en este orden: `{{1}}` nombre, `{{2}}` folio, `{{3}}` guía, `{{4}}` estado, `{{5}}` paquetería. Idioma predeterminado: `es_MX`.
3. En Render, guarda `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_TEMPLATE_NAME`, `WHATSAPP_TEMPLATE_LANGUAGE`, `WHATSAPP_VERIFY_TOKEN` y `WHATSAPP_APP_SECRET` como variables privadas. `WHATSAPP_API_VERSION` usa `v25.0` (la versión indicada por Meta en los datos de configuración compartidos).
4. En el panel de Meta, configura la URL `https://lobo-telecom-i4uk.onrender.com/api/whatsapp/webhook`, el mismo token de verificación y suscribe el campo `messages`. El webhook recibe respuestas entrantes y acuses de entrega/lectura.
5. Los mensajes de actualización salen mediante plantilla aprobada. Las respuestas libres del bot funcionan cuando el cliente inicia la conversación y abre la ventana de atención de WhatsApp.

El servidor valida la firma del webhook con el secreto de la app, deduplica los mensajes entrantes y registra los estados `accepted`, `delivered`, `read` o `failed`. Un HTTP 200 de Meta confirma aceptación por la API; solo el webhook confirma entrega o lectura.

La API no cobra una tarifa de acceso por sí misma, pero Meta puede cobrar por mensajes de plantilla según categoría, país y tarifas vigentes. Revisa la facturación de tu cuenta antes de activar notificaciones a clientes. Al pasar un número desde la aplicación WhatsApp/Business a Cloud API puede ser necesario registrarlo o migrarlo según la configuración de Meta.

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
- El panel administrativo muestra la configuración de Cloud API y la URL del webhook de Meta.


## Mantenimiento del panel
- El administrador puede eliminar usuarios del equipo y paquetes desde sus tarjetas. Ambas acciones piden confirmación; al quitar un paquete se eliminan también sus eventos e historial de avisos vinculados.
- La dirección de entrega admite texto o un enlace compartido de Google Maps. El botón del repartidor abre la ruta en Maps; las direcciones en texto se convierten en un destino de ruta.
- La interfaz administrativa incluye navegación por resumen, registro, inventario, equipo y WhatsApp.


## Cola y recuperación de avisos WhatsApp
- Con autorización registrada, cada aviso se guarda primero en PostgreSQL. Si Cloud API no está configurada temporalmente, el aviso se queda en cola y se reintenta al agregar las credenciales necesarias.
- El panel muestra en cola, enviando, enviado, fallido u omitido. **Reintentar pendientes y fallidos** procesa hasta cinco avisos por lote; el sistema aplica pausas entre envíos y reintentos escalonados.
- Los estados antiguos pendientes se reemplazan por el último estado del paquete para evitar enviar novedades atrasadas.
- La cola no anula la autorización del cliente. En Render Free el procesamiento se pausa cuando el servicio se suspende y continúa cuando vuelve a estar activo.


### Confirmaciones de entrega
El panel distingue aceptación de Meta (`accepted`), entrega (`delivered`), lectura (`read`) y fallo (`failed`). La aceptación HTTP no se presenta como entrega; los acuses del webhook se vinculan por el ID de Meta y se guardan en PostgreSQL incluso si llegan antes que el resultado del envío.

