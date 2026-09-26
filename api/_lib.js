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
    grokKey: h("x-grok-key") || process.env.XAI_API_KEY || "",
    grokModel: h("x-grok-model") || process.env.GROK_MODEL || "grok-4.7",
    deepseekKey: h("x-deepseek-key") || process.env.DEEPSEEK_API_KEY || "",
    deepseekModel: h("x-deepseek-model") || process.env.DEEPSEEK_MODEL || "deepseek-flash",
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

async function geminiLlamada(cfg, model, body, ms) {
  const r = await fetchTimeout(
    `${GEMINI_BASE}/v1beta/models/${model}:generateContent`,
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

// Si el modelo esta saturado (503/500) reintenta con uno mas liviano.
async function gemini(cfg, body, ms = 50000) {
  requireGemini(cfg);
  try {
    return await geminiLlamada(cfg, cfg.geminiModel, body, ms);
  } catch (e) {
    if (e.status >= 500 && cfg.geminiModel !== "gemini-flash-lite-latest") {
      return geminiLlamada(cfg, "gemini-flash-lite-latest", body, ms);
    }
    throw e;
  }
}

// ---------------------------------------------------------------------------
// BUSQUEDA WEB
// ---------------------------------------------------------------------------
// La busqueda de Google dentro de Gemini ("grounding") no tiene cupo en el
// plan gratis. Si da 429 se busca en DuckDuckGo / Bing y Gemini lee las
// paginas encontradas con url_context (que si es gratis).
let sinGrounding = 0; // timestamp hasta el que no se reintenta google_search

const decodeHtml = (s) =>
  s.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").trim();

async function buscarDDG(q) {
  const r = await fetchTimeout(
    "https://html.duckduckgo.com/html/",
    {
      method: "POST",
      headers: { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded", Accept: "text/html" },
      body: new URLSearchParams({ q, kl: "wt-wt" }).toString(),
    },
    12000
  );
  const html = await r.text();
  const out = [];
  const re = /class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:class="result__snippet"[^>]*>([\s\S]*?)<\/a>)?/g;
  let m;
  while ((m = re.exec(html))) {
    let url = m[1].replace(/&amp;/g, "&");
    const u = url.match(/[?&]uddg=([^&]+)/);
    if (u) url = decodeURIComponent(u[1]);
    if (url.startsWith("//")) url = "https:" + url;
    if (/^https?:\/\//.test(url) && !/duckduckgo\.com\/y\.js/.test(url)) out.push({ titulo: decodeHtml(m[2]), url, snippet: decodeHtml(m[3] || "") });
  }
  return out;
}

async function buscarBing(q) {
  const r = await fetchTimeout(`https://www.bing.com/search?q=${encodeURIComponent(q)}&setlang=es`, { headers: { "User-Agent": UA, Accept: "text/html" } }, 12000);
  const html = await r.text();
  const out = [];
  const re = /<li class="b_algo"[\s\S]*?<h2[^>]*><a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<p[^>]*>([\s\S]*?)<\/p>)?/g;
  let m;
  while ((m = re.exec(html))) {
    let url = m[1].replace(/&amp;/g, "&");
    const u = url.match(/[?&]u=a1([^&]+)/);
    if (/bing\.com\/ck\/a/.test(url) && u) {
      try {
        url = Buffer.from(u[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
      } catch (e) {}
    }
    if (/^https?:\/\//.test(url)) out.push({ titulo: decodeHtml(m[2]), url, snippet: decodeHtml(m[3] || "") });
  }
  return out;
}

async function buscarWeb(q) {
  try {
    const r = await buscarDDG(q);
    if (r.length) return r;
  } catch (e) {}
  try {
    return await buscarBing(q);
  } catch (e) {
    return [];
  }
}

// Llama a Gemini con busqueda web. Primero intenta google_search; si no hay
// cupo, busca las `consultas` en DDG/Bing y le pasa los resultados a Gemini
// (con url_context para que pueda abrir las paginas).
// Devuelve {text, chunks:[{uri,title}], resultados:[{titulo,url,snippet}]}.
async function geminiConBusqueda(cfg, { contents, systemInstruction, consultas, generationConfig = { temperature: 0.2 } }) {
  if (Date.now() > sinGrounding) {
    try {
      const r = await gemini(cfg, { contents, systemInstruction, tools: [{ google_search: {} }], generationConfig });
      return { ...r, resultados: [] };
    } catch (e) {
      if (e.status !== 429 && e.status !== 403) throw e;
      sinGrounding = Date.now() + 10 * 60 * 1000;
    }
  }
  const listas = await Promise.all(consultas.map(buscarWeb));
  const vistos = new Set();
  const resultados = [];
  listas.flat().forEach((x) => {
    if (!vistos.has(x.url)) {
      vistos.add(x.url);
      resultados.push(x);
    }
  });
  const top = resultados.slice(0, 18);
  const contexto = top.length
    ? "Resultados de busqueda web (podes abrir estos links para leerlos):\n" + top.map((x, i) => `${i + 1}. ${x.titulo}\n   ${x.url}\n   ${x.snippet}`).join("\n")
    : "(La busqueda web no devolvio resultados: respondé con tu conocimiento y aclaralo.)";
  const ultimo = contents[contents.length - 1];
  const conCtx = [...contents.slice(0, -1), { ...ultimo, parts: [{ text: contexto }, ...ultimo.parts] }];
  let r;
  try {
    r = await gemini(cfg, { contents: conCtx, systemInstruction, tools: [{ url_context: {} }], generationConfig });
  } catch (e) {
    if (e.status !== 429 && e.status !== 400) throw e;
    r = await gemini(cfg, { contents: conCtx, systemInstruction, generationConfig });
  }
  return { text: r.text, chunks: top.slice(0, 5).map((x) => ({ uri: x.url, title: x.titulo })), resultados: top };
}

// ---------------------------------------------------------------------------
// VARIAS IAs (Gemini, Grok, DeepSeek)
// ---------------------------------------------------------------------------
const NOMBRE_IA = { gemini: "Gemini", grok: "Grok", deepseek: "DeepSeek" };

function iasDisponibles(cfg) {
  return ["gemini", "grok", "deepseek"].filter((ia) => cfg[ia + "Key"]);
}

async function grok(cfg, { system, prompt, web }, ms) {
  const r = await fetchTimeout(
    "https://api.x.ai/v1/responses",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + cfg.grokKey },
      body: JSON.stringify({
        model: cfg.grokModel,
        input: [...(system ? [{ role: "system", content: system }] : []), { role: "user", content: prompt }],
        ...(web ? { tools: [{ type: "web_search" }] } : {}),
      }),
    },
    ms
  );
  const j = await r.json();
  if (!r.ok) throw fail(r.status, "Grok: " + ((j.error && (j.error.message || j.error)) || j.message || r.status));
  let text = j.output_text || "";
  const fuentes = [];
  (j.output || []).forEach((o) =>
    (o.content || []).forEach((c) => {
      if (c.type === "output_text") {
        if (!j.output_text) text += c.text || "";
        (c.annotations || []).forEach((a) => a.url && fuentes.push({ uri: a.url, title: a.title || a.url }));
      }
    })
  );
  (j.citations || []).forEach((u) => typeof u === "string" && fuentes.push({ uri: u, title: u }));
  return { text, chunks: fuentes };
}

async function deepseek(cfg, { system, prompt }, ms) {
  const r = await fetchTimeout(
    "https://api.deepseek.com/chat/completions",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + cfg.deepseekKey },
      body: JSON.stringify({
        model: cfg.deepseekModel,
        messages: [...(system ? [{ role: "system", content: system }] : []), { role: "user", content: prompt }],
        reasoning_effort: "low",
        stream: false,
      }),
    },
    ms
  );
  const j = await r.json();
  if (!r.ok) throw fail(r.status, "DeepSeek: " + ((j.error && j.error.message) || r.status));
  return { text: (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || "", chunks: [] };
}

// Pregunta a una IA en modo texto. web=true: Gemini y Grok buscan solos;
// a DeepSeek (sin busqueda propia) se le pasan resultados de Bing.
// `consultas` son las busquedas a usar cuando hace falta buscar "a mano".
async function preguntarIA(cfg, ia, { system, prompt, web, consultas = [] }, ms = 40000) {
  if (ia === "gemini") {
    const contents = [{ role: "user", parts: [{ text: prompt }] }];
    const systemInstruction = system ? { parts: [{ text: system }] } : undefined;
    const r = web ? await geminiConBusqueda(cfg, { contents, systemInstruction, consultas }) : await gemini(cfg, { contents, systemInstruction }, ms);
    return { ia, text: r.text, chunks: r.chunks || [], resultados: r.resultados || [] };
  }
  if (ia === "grok") return { ia, ...(await grok(cfg, { system, prompt, web }, ms)), resultados: [] };
  if (ia === "deepseek") {
    let ctx = "";
    let resultados = [];
    if (web && consultas.length) {
      resultados = (await Promise.all(consultas.map(buscarWeb))).flat().slice(0, 15);
      if (resultados.length) ctx = "Resultados de busqueda web:\n" + resultados.map((x, i) => `${i + 1}. ${x.titulo}\n   ${x.url}\n   ${x.snippet}`).join("\n") + "\n\n";
    }
    const r = await deepseek(cfg, { system, prompt: ctx + prompt }, ms);
    return { ia, ...r, chunks: resultados.slice(0, 5).map((x) => ({ uri: x.url, title: x.titulo })), resultados };
  }
  throw fail(400, "IA desconocida: " + ia);
}

// Pregunta a todas las IAs configuradas en paralelo.
// Devuelve [{ia, ok, text, chunks, resultados, error}].
async function preguntarTodas(cfg, opts, ms) {
  const ias = iasDisponibles(cfg);
  if (!ias.length) throw fail(400, "No hay ninguna IA configurada. Cargá al menos la clave de Gemini en Configuración.");
  const rs = await Promise.allSettled(ias.map((ia) => preguntarIA(cfg, ia, opts, ms)));
  return rs.map((r, i) => (r.status === "fulfilled" ? { ...r.value, ok: true } : { ia: ias[i], ok: false, error: r.reason.message }));
}

// La primera IA que responda, en orden de preferencia (si Gemini falla por
// cupo, responde Grok o DeepSeek).
async function preguntarPrimera(cfg, opts, ms) {
  const ias = iasDisponibles(cfg);
  if (!ias.length) throw fail(400, "No hay ninguna IA configurada. Cargá al menos la clave de Gemini en Configuración.");
  let ultimo;
  for (const ia of ias) {
    try {
      return await preguntarIA(cfg, ia, opts, ms);
    } catch (e) {
      ultimo = e;
    }
  }
  throw ultimo;
}

// Una IA "jueza" elige la mejor respuesta. Devuelve {mejor, motivo}.
async function elegirMejor(cfg, pregunta, respuestas) {
  const validas = respuestas.filter((r) => r.ok && r.text.trim());
  if (validas.length <= 1) return { mejor: validas[0] ? validas[0].ia : null, motivo: "" };
  const juez = iasDisponibles(cfg)[0];
  const prompt = `Pregunta tecnica de ingenieria biomedica: "${pregunta}"

${validas.map((r) => `### Respuesta de ${r.ia}\n${r.text.slice(0, 6000)}`).join("\n\n")}

Evaluá cual respuesta es mas correcta, especifica, segura y util para un tecnico (preferí la que cita manual o fuentes verificables y no inventa datos). Respondé solo JSON: {"mejor":"${validas.map((r) => r.ia).join("|")}","motivo":"una frase"}`;
  try {
    const r = await preguntarIA(cfg, juez, { prompt }, 20000);
    const d = parseJson(r.text) || {};
    if (validas.some((v) => v.ia === d.mejor)) return { mejor: d.mejor, motivo: d.motivo || "", juez };
  } catch (e) {}
  return { mejor: validas[0].ia, motivo: "", juez: null };
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

// Igual que geminiUriForDrive pero para un manual {driveId?, url?, titulo}:
// si todavia no esta en Drive, baja el PDF desde su link original.
const urlCache = {};
async function geminiUriForManual(cfg, m) {
  if (m.driveId) {
    const token = await driveToken(cfg);
    return geminiUriForDrive(cfg, token, m.driveId, m.titulo);
  }
  if (!m.url) throw fail(400, "manual sin archivo");
  const c = urlCache[m.url];
  if (c && c.exp > Date.now()) return c.uri;
  const r = await fetchTimeout(m.url, { headers: { "User-Agent": UA } }, 25000);
  if (!r.ok) throw fail(502, "No se pudo bajar el PDF (" + r.status + ")");
  const buf = Buffer.from(await r.arrayBuffer());
  if (!buf.slice(0, 1024).toString("latin1").includes("%PDF")) throw fail(502, "El link ya no devuelve un PDF");
  const uri = await geminiUploadFile(cfg, buf, "application/pdf", m.titulo || "manual");
  urlCache[m.url] = { uri, exp: Date.now() + 46 * 3600 * 1000 };
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
  geminiConBusqueda,
  NOMBRE_IA,
  iasDisponibles,
  preguntarIA,
  preguntarTodas,
  preguntarPrimera,
  elegirMejor,
  parseJson,
  geminiUriForDrive,
  geminiUriForManual,
};
