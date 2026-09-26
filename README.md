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
| `GEMINI_API_KEY` | sí | https://aistudio.google.com/apikey |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | sí (Drive) | ver abajo |
| `GOOGLE_REFRESH_TOKEN` | sí (Drive) | lo genera la app con “Conectar Google Drive” |
| `ADMIN_PIN` | recomendado | PIN para entrar a Configuración (si no está, cada dispositivo crea el suyo) |
| `YOUTUBE_API_KEY` | no | Google Cloud → habilitar “YouTube Data API v3” → Credenciales → Clave de API |
| `DRIVE_FOLDER_ID` | no | si no se pone, la app crea la carpeta “Manuales SEM” |
| `GEMINI_MODEL` | no | por defecto `gemini-flash-latest` |

### Google Drive (OAuth)
1. https://console.cloud.google.com → crear proyecto → **APIs y servicios → Biblioteca** → habilitar **Google Drive API**.
2. **Pantalla de consentimiento de OAuth**: tipo *Externo*, agregá tu mail como usuario de prueba y luego **Publicar la app** (en modo “prueba” el acceso vence a los 7 días). El permiso que se pide es `drive.file` (solo los archivos que crea la app), no requiere verificación de Google.
3. **Credenciales → Crear credenciales → ID de cliente OAuth → Aplicación web**. En *URI de redireccionamiento autorizados* poné `https://manualapp-one.vercel.app/api/drive-auth`.
4. Copiá el ID y el secreto a `GOOGLE_CLIENT_ID` y `GOOGLE_CLIENT_SECRET` en Vercel y redeployá.
5. En la app: ⚙ Configuración → **Conectar Google Drive** → aceptás → copiás el token que muestra a `GOOGLE_REFRESH_TOKEN` en Vercel y redeployá (o “Guardar en este navegador” para probar ya).

## Instalar como app
Botón **Instalar app** arriba (Android/Chrome/Edge). En iPhone: Compartir → “Agregar a pantalla de inicio”.
