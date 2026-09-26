// POST {url, tipo, titulo, equipo, modelo}
// Descarga el link; si es PDF lo guarda en Drive. Si es una pagina HTML,
// busca adentro links a .pdf y prueba los mas relevantes. Asi se descartan
// las paginas "de visualizacion" que no permiten descargar.
const { UA, handler, send, fail, fetchTimeout, driveToken, driveFolder, driveUpload } = require("./_lib");

const MAX_BYTES = 80 * 1024 * 1024;

function normalizarUrl(u) {
  let m = u.match(/drive\.google\.com\/file\/d\/([^/?#]+)/) || u.match(/drive\.google\.com\/open\?id=([^&#]+)/);
  if (m) return `https://drive.google.com/uc?export=download&id=${m[1]}`;
  if (/dropbox\.com\//.test(u)) return u.replace(/([?&])dl=0/, "$1dl=1");
  return u;
}

async function bajar(url) {
  const r = await fetchTimeout(url, { headers: { "User-Agent": UA, Accept: "application/pdf,text/html;q=0.9,*/*;q=0.8" }, redirect: "follow" }, 25000);
  if (!r.ok) return { error: `HTTP ${r.status}` };
  const len = Number(r.headers.get("content-length") || 0);
  if (len > MAX_BYTES) return { error: "archivo demasiado grande (" + Math.round(len / 1048576) + " MB)" };
  const buf = Buffer.from(await r.arrayBuffer());
  const ct = (r.headers.get("content-type") || "").toLowerCase();
  const esPdf = buf.slice(0, 1024).toString("latin1").includes("%PDF");
  return { buf, ct, esPdf, finalUrl: r.url || url };
}

function linksPdf(html, base, claves) {
  const out = new Set();
  const re = /href\s*=\s*["']([^"'#]+)["']/gi;
  let m;
  while ((m = re.exec(html))) {
    const h = m[1].replace(/&amp;/g, "&");
    if (/\.pdf(\?|$)/i.test(h) || /download/i.test(h)) {
      try {
        out.add(new URL(h, base).toString());
      } catch (e) {}
    }
  }
  const score = (u) => {
    const l = u.toLowerCase();
    let s = /\.pdf(\?|$)/.test(l) ? 2 : 0;
    claves.forEach((c) => c && l.includes(c) && (s += 3));
    return s;
  };
  return [...out].sort((a, b) => score(b) - score(a)).slice(0, 4);
}

function nombreArchivo(equipo, tipo, titulo) {
  const base = `${equipo || "Equipo"} - ${tipo || "manual"} - ${titulo || ""}`.replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim();
  return base.slice(0, 120) + ".pdf";
}

module.exports = handler(async (req, res, cfg) => {
  const { url, tipo = "", titulo = "", equipo = "", modelo = "" } = req.body || {};
  if (!/^https?:\/\//.test(url || "")) throw fail(400, "url invalida");

  const claves = String(modelo || equipo)
    .toLowerCase()
    .split(/[\s\-_/]+/)
    .filter((c) => c.length >= 3);

  let pdf = null;
  let origen = normalizarUrl(url);
  let motivo = "";
  const primero = await bajar(origen).catch((e) => ({ error: e.name === "AbortError" ? "tiempo agotado" : e.message }));
  if (primero.error) motivo = primero.error;
  else if (primero.esPdf) pdf = primero;
  else if (primero.ct.includes("html")) {
    const candidatos = linksPdf(primero.buf.toString("utf8"), primero.finalUrl, claves);
    motivo = candidatos.length ? "la pagina no tiene un PDF descargable valido" : "es una pagina web sin PDF descargable";
    for (const c of candidatos) {
      const r = await bajar(c).catch(() => ({ error: "x" }));
      if (r.esPdf) {
        pdf = r;
        origen = c;
        break;
      }
    }
  } else motivo = "no es un PDF (" + (primero.ct || "tipo desconocido") + ")";

  if (!pdf) return send(res, 200, { ok: false, motivo });

  const manual = {
    tipo,
    titulo: titulo || nombreArchivo(equipo, tipo, "").replace(/\.pdf$/, ""),
    url: origen,
    fuente: (() => {
      try {
        return new URL(origen).hostname.replace(/^www\./, "");
      } catch (e) {
        return "";
      }
    })(),
    tamano: pdf.buf.length,
    driveId: null,
    driveLink: null,
  };

  try {
    const token = await driveToken(cfg);
    const folderId = await driveFolder(token, cfg);
    const f = await driveUpload(token, {
      folderId,
      name: nombreArchivo(equipo, tipo, titulo),
      mime: "application/pdf",
      buffer: pdf.buf,
    });
    manual.driveId = f.id;
    manual.driveLink = f.webViewLink || `https://drive.google.com/file/d/${f.id}/view`;
  } catch (e) {
    manual.aviso = "PDF valido pero no se guardo en Drive: " + e.message;
  }
  send(res, 200, { ok: true, manual });
});
