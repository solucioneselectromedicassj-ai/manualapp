# Manuales SEM

Biblioteca de manuales de equipos biomédicos. Escribís el nombre de un equipo, la app busca los manuales en internet, **se queda solo con PDFs descargables**, los guarda en tu **Google Drive** y después le hacés consultas (Gemini lee el PDF y cita la página). También junta videos de YouTube, insumos y repuestos.

## Cómo funciona

| Paso | Endpoint | Servicio |
|---|---|---|
| Buscar manuales, insumos y videos sugeridos | `api/buscar.js` | Gemini + Google Search |
| Validar que el link sea un PDF (o encontrar el PDF dentro de la página) y subirlo a Drive | `api/descargar.js` | Drive |
| Subir un PDF propio desde el teléfono/PC | `api/subir.js` | Drive (subida directa desde el navegador) |
| Videos verificados | `api/videos.js` | YouTube Data API (opcional) / oEmbed |
| Insumos y repuestos con código y página | `api/extraer.js` | Gemini leyendo el PDF |
| Consultas sobre el manual | `api/consultar.js` | Gemini leyendo el PDF |
| Biblioteca (`equipos.json` en la carpeta de Drive) | `api/equipos.js` | Drive |
| Estado de las APIs y PIN | `api/estado.js` | — |
| Conectar Drive (una sola vez) | `api/drive-auth.js` | Google OAuth |

## Configuración (una sola vez)

En Vercel → proyecto → **Settings → Environment Variables**:

| Variable | Obligatoria | De dónde sale |
|---|---|---|
| `GEMINI_API_KEY` | sí | [AI Studio → API keys](https://aistudio.google.com/apikey) |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | sí (Drive) | ver abajo |
| `GOOGLE_REFRESH_TOKEN` | sí (Drive) | lo genera la app con “Conectar Google Drive” |
| `ADMIN_PIN` | recomendado | PIN para entrar a Configuración (si no está, cada dispositivo crea el suyo) |
| `XAI_API_KEY` | no | Grok: [consola xAI → API keys](https://console.x.ai/team/default/api-keys) (pago por uso) |
| `DEEPSEEK_API_KEY` | no | DeepSeek: [Platform → API keys](https://platform.deepseek.com/api_keys) + [Top up](https://platform.deepseek.com/top_up) |
| `YOUTUBE_API_KEY` | no | [Habilitar YouTube Data API v3](https://console.cloud.google.com/apis/library/youtube.googleapis.com) → [Credenciales](https://console.cloud.google.com/apis/credentials) → Clave de API |
| `DRIVE_FOLDER_ID` | no | si no se pone, la app crea la carpeta “Manuales SEM” |
| `GEMINI_MODEL` | no | por defecto `gemini-flash-latest` |

### Google Drive (OAuth)
1. [Crear proyecto](https://console.cloud.google.com/projectcreate) → [habilitar Google Drive API](https://console.cloud.google.com/apis/library/drive.googleapis.com).
2. [Pantalla de consentimiento (Google Auth Platform)](https://console.cloud.google.com/auth/overview): tipo *Externo*, agregá tu mail como usuario de prueba y luego **Publicar la app** (en modo “prueba” el acceso vence a los 7 días). El permiso que se pide es `drive.file` (solo los archivos que crea la app), no requiere verificación de Google.
3. [Crear cliente OAuth](https://console.cloud.google.com/auth/clients/create) → **Aplicación web**. En *URI de redireccionamiento autorizados* poné `https://manualapp-one.vercel.app/api/drive-auth`.
4. Copiá el ID y el secreto a `GOOGLE_CLIENT_ID` y `GOOGLE_CLIENT_SECRET` en Vercel y redeployá.
5. En la app: ⚙ Configuración → **Conectar Google Drive** → aceptás → copiás el token que muestra a `GOOGLE_REFRESH_TOKEN` en Vercel y redeployá (o “Guardar en este navegador” para probar ya).

La misma guía con links está en la app: ⚙ Configuración → *Guía rápida*.

## Varias IAs (Gemini, Grok, DeepSeek)
- Al agregar un equipo, todas las IAs configuradas buscan los manuales en paralelo. Cada link queda marcado con la IA que lo sugirió; la app lo descarga y solo se queda con PDFs reales, así que el **Ranking de IAs** (en Configuración) mide cuál encuentra de verdad los manuales.
- Las fallas comunes se juntan de todas las IAs.
- En Consulta, la casilla **Comparar IAs** pregunta a todas y una IA jueza elige la mejor respuesta (las demás quedan desplegables). Solo Gemini lee los PDF; Grok y DeepSeek responden con búsqueda web.
- Si Gemini se queda sin cupo, responde la siguiente IA disponible.

## Fallas, códigos de acceso, fotos y archivos
- **Fallas**: busca las fallas y sus **códigos de error** (Err 12, E-04, etc.) más comunes en el manual (troubleshooting) y en foros; podés registrar las tuyas con su reparación y foto, y sumar otras formas de reparar. Las consultas usan ese registro propio.
- **Acceso** (pestaña nueva): cómo llegar a la pantalla del modo de servicio/configuración de cada equipo, y una lista de códigos candidatos (de fábrica o genéricos que circulan entre técnicos) para probar. Al marcar uno como "✓ Funcionó" queda fijado arriba como el código confirmado — la próxima vez no hay que volver a probar todos. Ese código y los pasos de acceso también alimentan las Consultas, y la biblioteca muestra un 🔑 en la tarjeta del equipo que ya tiene uno confirmado.
- **Fotos y archivos**: fotos (se achican antes de subir) y cualquier archivo que no esté en la app, guardados en Drive. Los PDF subidos también se usan en las consultas.

## Instalar como app
Botón **Instalar app** arriba (Android/Chrome/Edge). En iPhone: Compartir → “Agregar a pantalla de inicio”.
