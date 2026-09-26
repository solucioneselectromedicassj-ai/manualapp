// Helpers compartidos por las funciones de /api (Vercel no expone como ruta
// los archivos que empiezan con "_").
//
// Configuracion: se lee de las variables de entorno de Vercel. Si el panel
// de Configuracion de la app tiene claves cargadas, llegan por headers y
// tienen prioridad (sirve para probar sin redeployar).

const GEMINI_BASE = "https://generativelanguage.googleapis.com";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

function getCfg(req) {
  const h = (k) => (req.headers[k] || "").toString().trim();
  return {
    geminiKey: h("x-gemini-key") || process.env.GEMINI_API_KEY || "",
    geminiModel: h("x-gemini-model") || process.env.GEMINI_MODEL || "gemini-flash-latest",
    youtubeKey: h("x-youtube-key") || process.env.YOUTUBE_API_KEY || "",
    clientId: process.env.GOOGLE_CLIENT_ID || "",
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || "",
    refreshToken: h("x-google-refresh-token") || process.env.GOOGLE_REFRESH_TOKEN || "",
    folderId: h("x-drive-folder") || process.env.DRIVE_FOLDER_ID || "",
  };
}

function send(res, status, data) {
  res.status(status).setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(data));
}

function handler(fn) {
  return async (req, res) => {
    try {
      await fn(req, res, getCfg(req));
    } catch (e) {
      console.error(e);
      send(res, e.status || 500, { error: e.message || String(e) });
    }
  };
}

function fail(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

async function fetchTimeout(url, opts = {}, ms = 20000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

// ---------------------------------------------------------------------------
// GOOGLE DRIVE (OAuth con refresh token del usuario, scope drive.file)
// ---------------------------------------------------------------------------
const tokenCache = {};
const folderCache = {};

async function driveToken(cfg) {
  if (!cfg.clientId || !cfg.clientSecret || !cfg.refreshToken) {
    throw fail(400, "Google Drive no esta conectado (faltan GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / refresh token).");
  }
  const c = tokenCache[cfg.refreshToken];
  if (c && c.exp > Date.now() + 60000) return c.token;
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      refresh_token: cfg.refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const j = await r.json();
  if (!r.ok) throw fail(401, "Drive: no se pudo renovar el acceso (" + (j.error_description || j.error) + "). Volve a conectar Drive.");
  tokenCache[cfg.refreshToken] = { token: j.access_token, exp: Date.now() + j.expires_in * 1000 };
  return j.access_token;
}

async function driveApi(token, path, opts = {}) {
  const r = await fetch("https://www.googleapis.com" + path, {
    ...opts,
    headers: { Authorization: "Bearer " + token, ...(opts.headers || {}) },
  });
  if (!r.ok) {
    const txt = await r.text();
    throw fail(r.status, "Drive " + r.status + ": " + txt.slice(0, 300));
  }
  return r;
}

async function driveFolder(token, cfg) {
  if (cfg.folderId) return cfg.folderId;
  if (folderCache[cfg.refreshToken]) return folderCache[cfg.refreshToken];
  const q = encodeURIComponent("name='Manuales SEM' and mimeType='application/vnd.google-apps.folder' and trashed=false");
  const r = await driveApi(token, `/drive/v3/files?q=${q}&fields=files(id)`);
  const j = await r.json();
  let id = j.files && j.files[0] && j.files[0].id;
  if (!id) {
    const c = await driveApi(token, "/drive/v3/files?fields=id", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Manuales SEM", mimeType: "application/vnd.google-apps.folder" }),
    });
    id = (await c.json()).id;
  }
  folderCache[cfg.refreshToken] = id;
  return id;
}

async function driveFindByName(token, folderId, name) {
  const q = encodeURIComponent(`name='${name.replace(/'/g, "\\'")}' and '${folderId}' in parents and trashed=false`);
  const r = await driveApi(token, `/drive/v3/files?q=${q}&fields=files(id,name)`);
  const j = await r.json();
  return (j.files && j.files[0]) || null;
}

// Sube (o reemplaza si se pasa fileId) un archivo con upload resumable.
async function driveUpload(token, { folderId, name, mime, buffer, fileId, appProperties }) {
  const meta = fileId ? {} : { name, parents: [folderId] };
  if (appProperties) meta.appProperties = appProperties;
  const init = await driveApi(
    token,
    fileId
      ? `/upload/drive/v3/files/${fileId}?uploadType=resumable`
      : "/upload/drive/v3/files?uploadType=resumable",
    {
      method: fileId ? "PATCH" : "POST",
      headers: {
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Type": mime,
        "X-Upload-Content-Length": String(buffer.length),
      },
      body: JSON.stringify(meta),
    }
  );
  const uploadUrl = init.headers.get("location");
  const up = await fetch(uploadUrl + "&fields=id,name,webViewLink,size", {
    method: "PUT",
    headers: { "Content-Type": mime },
    body: buffer,
  });
  if (!up.ok) throw fail(up.status, "Drive upload " + up.status + ": " + (await up.text()).slice(0, 300));
  return up.json();
}

async function driveDownload(token, fileId) {
  const r = await driveApi(token, `/drive/v3/files/${fileId}?alt=media`);
  return Buffer.from(await r.arrayBuffer());
}

async function driveMeta(token, fileId, fields = "id,name,mimeType,size,appProperties") {
  const r = await driveApi(token, `/drive/v3/files/${fileId}?fields=${fields}`);
  return r.json();
}

async function driveSetProps(token, fileId, appProperties) {
  await driveApi(token, `/drive/v3/files/${fileId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ appProperties }),
  });
}

// ---------------------------------------------------------------------------
// GEMINI
// ---------------------------------------------------------------------------
function requireGemini(cfg) {
  if (!cfg.geminiKey) throw fail(400, "Falta la clave de Gemini (GEMINI_API_KEY). Cargala en Configuracion.");
}

async function gemini(cfg, body, ms = 50000) {
  requireGemini(cfg);
  const r = await fetchTimeout(
    `${GEMINI_BASE}/v1beta/models/${cfg.geminiModel}:generateContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": cfg.geminiKey },
      body: JSON.stringify(body),
    },
    ms
  );
  const j = await r.json();
  if (!r.ok) throw fail(r.status, "Gemini: " + ((j.error && j.error.message) || r.status));
  const cand = (j.candidates || [])[0] || {};
  const text = ((cand.content && cand.content.parts) || []).map((p) => p.text || "").join("");
  const chunks = ((cand.groundingMetadata && cand.groundingMetadata.groundingChunks) || [])
    .map((c) => c.web)
    .filter(Boolean);
  return { text, chunks };
}

// Extrae el primer bloque JSON de un texto (Gemini con google_search no
// acepta responseMimeType json, asi que se parsea a mano).
function parseJson(text) {
  const m = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = m ? m[1] : text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  try {
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

async function geminiUploadFile(cfg, buffer, mime, displayName) {
  requireGemini(cfg);
  const start = await fetch(`${GEMINI_BASE}/upload/v1beta/files`, {
    method: "POST",
    headers: {
      "x-goog-api-key": cfg.geminiKey,
      "X-Goog-Upload-Protocol": "resumable",
      "X-Goog-Upload-Command": "start",
      "X-Goog-Upload-Header-Content-Length": String(buffer.length),
      "X-Goog-Upload-Header-Content-Type": mime,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ file: { display_name: displayName.slice(0, 100) } }),
  });
  if (!start.ok) throw fail(start.status, "Gemini files: " + (await start.text()).slice(0, 300));
  const url = start.headers.get("x-goog-upload-url");
  const up = await fetch(url, {
    method: "POST",
    headers: { "X-Goog-Upload-Offset": "0", "X-Goog-Upload-Command": "upload, finalize" },
    body: buffer,
  });
  const j = await up.json();
  if (!up.ok) throw fail(up.status, "Gemini files: " + JSON.stringify(j).slice(0, 300));
  let file = j.file;
  for (let i = 0; i < 20 && file.state === "PROCESSING"; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    const g = await fetch(`${GEMINI_BASE}/v1beta/${file.name}`, { headers: { "x-goog-api-key": cfg.geminiKey } });
    file = await g.json();
  }
  if (file.state === "FAILED") throw fail(500, "Gemini no pudo procesar el PDF");
  return file.uri;
}

// Devuelve un URI de Gemini Files para un PDF guardado en Drive. Los archivos
// de Gemini duran 48 h: se cachea el URI en appProperties del archivo de Drive.
async function geminiUriForDrive(cfg, token, driveId, titulo) {
  const meta = await driveMeta(token, driveId);
  const p = meta.appProperties || {};
  if (p.gemUri && Number(p.gemExp) > Date.now()) return p.gemUri;
  const buf = await driveDownload(token, driveId);
  const uri = await geminiUploadFile(cfg, buf, meta.mimeType || "application/pdf", titulo || meta.name);
  await driveSetProps(token, driveId, { gemUri: uri, gemExp: String(Date.now() + 46 * 3600 * 1000) });
  return uri;
}

module.exports = {
  UA,
  getCfg,
  send,
  handler,
  fail,
  fetchTimeout,
  driveToken,
  driveApi,
  driveFolder,
  driveFindByName,
  driveUpload,
  driveDownload,
  driveMeta,
  gemini,
  parseJson,
  geminiUriForDrive,
};
