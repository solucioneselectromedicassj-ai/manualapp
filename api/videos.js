// POST {nombre, sugeridos:[{titulo,url}]} -> videos de YouTube verificados.
// Con YOUTUBE_API_KEY usa la busqueda oficial; sin clave valida los links
// sugeridos por Gemini con oEmbed (descarta los inexistentes).
const { handler, send, fail, fetchTimeout } = require("./_lib");

function idDe(url) {
  const m = String(url).match(/(?:v=|youtu\.be\/|embed\/|shorts\/)([\w-]{11})/);
  return m ? m[1] : null;
}

async function porApi(key, q) {
  const u = new URL("https://www.googleapis.com/youtube/v3/search");
  u.search = new URLSearchParams({ part: "snippet", type: "video", maxResults: "8", q, key, relevanceLanguage: "es" }).toString();
  const r = await fetchTimeout(u, {}, 15000);
  const j = await r.json();
  if (!r.ok) throw fail(r.status, "YouTube: " + ((j.error && j.error.message) || r.status));
  return (j.items || []).map((it) => ({
    id: it.id.videoId,
    titulo: it.snippet.title,
    canal: it.snippet.channelTitle,
    url: `https://www.youtube.com/watch?v=${it.id.videoId}`,
  }));
}

async function verificar(v) {
  const id = idDe(v.url);
  if (!id) return null;
  const url = `https://www.youtube.com/watch?v=${id}`;
  try {
    const r = await fetchTimeout(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url)}`, {}, 8000);
    if (!r.ok) return null;
    const j = await r.json();
    return { id, titulo: j.title || v.titulo, canal: j.author_name || "", url };
  } catch (e) {
    return null;
  }
}

module.exports = handler(async (req, res, cfg) => {
  const { nombre = "", sugeridos = [] } = req.body || {};
  if (!nombre) throw fail(400, "falta nombre");
  let videos = [];
  let aviso = "";
  if (cfg.youtubeKey) {
    const [a, b] = await Promise.all([
      porApi(cfg.youtubeKey, `${nombre} service manual reparacion calibracion`),
      porApi(cfg.youtubeKey, `${nombre} tutorial`),
    ]);
    const vistos = new Set();
    videos = [...a, ...b].filter((v) => !vistos.has(v.id) && vistos.add(v.id)).slice(0, 10);
  } else {
    aviso = "Sin YOUTUBE_API_KEY: se muestran solo los videos sugeridos por la busqueda que existen de verdad.";
    videos = (await Promise.all(sugeridos.slice(0, 10).map(verificar))).filter(Boolean);
  }
  send(res, 200, { videos, aviso, busqueda: `https://www.youtube.com/results?search_query=${encodeURIComponent(nombre + " service")}` });
});
