// POST {nombre} -> busca en internet (Gemini, Grok y DeepSeek en paralelo) los manuales
// del equipo y devuelve candidatos. Los links se validan despues en
// /api/descargar (que se queda solo con PDFs reales).
const { handler, send, fail, preguntarTodas, parseJson } = require("./_lib");

const PROMPT = (nombre) => `Sos un asistente de ingenieria biomedica. Buscá en internet los manuales del equipo medico: "${nombre}".

Necesito LINKS DIRECTOS A ARCHIVOS PDF descargables sin login (que terminen en .pdf o que descarguen un PDF), de:
- "usuario": manual de usuario / operator's manual / instructions for use
- "tecnico": service manual / manual tecnico / manual de servicio
- "despiece": parts list / spare parts / exploded view / despiece (si no hay, puede ser el mismo service manual)

Fuentes utiles: sitio del fabricante, frankshospitalworkshop.com, manualslib (solo si hay PDF directo), usermanual.wiki, device.report, manualzz, archive.org, foros de biomedicos, ministerios de salud, licitaciones. Evitá paginas que solo muestran el manual online sin PDF.

Tambien listá insumos/accesorios consumibles tipicos y repuestos comunes (con codigo/part number del fabricante si lo encontras), y videos de YouTube utiles (servicio, calibracion, reparacion, uso).

Respondé SOLO con JSON valido con esta forma:
{"nombre":"nombre corto del equipo","marca":"","modelo":"","tipoEquipo":"ej: Monitor multiparametrico",
"manuales":[{"tipo":"usuario|tecnico|despiece","titulo":"","url":"","fuente":"dominio"}],
"videos":[{"titulo":"","url":"https://www.youtube.com/watch?v=..."}],
"insumos":["..."],
"repuestos":[{"nombre":"","codigo":""}]}
Incluí hasta 4 links por tipo, ordenados del mas confiable al menos.`;

const dominio = (u) => (String(u).match(/\/\/(?:www\.)?([^/]+)/) || [])[1] || "";

module.exports = handler(async (req, res, cfg) => {
  const nombre = ((req.body && req.body.nombre) || "").toString().trim();
  if (!nombre) throw fail(400, "falta nombre");

  const respuestas = await preguntarTodas(
    cfg,
    {
      prompt: PROMPT(nombre),
      web: true,
      consultas: [
        `${nombre} service manual pdf`,
        `${nombre} user manual pdf`,
        `${nombre} operator's manual filetype:pdf`,
        `${nombre} parts list spare parts pdf`,
        `${nombre} manual de servicio pdf`,
      ],
    },
    42000
  );

  // Cada link candidato guarda que IAs lo sugirieron (para el ranking).
  const porUrl = new Map();
  const agregar = (m, ia) => {
    if (!m || !/^https?:\/\//.test(m.url || "")) return;
    const c = porUrl.get(m.url);
    if (c) {
      if (!c.ias.includes(ia)) c.ias.push(ia);
      if (!c.tipo && m.tipo) c.tipo = m.tipo;
      return;
    }
    porUrl.set(m.url, { tipo: m.tipo || "", titulo: m.titulo || "", url: m.url, fuente: m.fuente || dominio(m.url), ias: [ia] });
  };

  let info = null;
  const insumos = [];
  const repuestos = [];
  const videos = [];
  const resumen = [];

  respuestas.forEach((r) => {
    if (!r.ok) return resumen.push({ ia: r.ia, ok: false, error: r.error });
    const d = parseJson(r.text) || {};
    const antes = porUrl.size;
    (Array.isArray(d.manuales) ? d.manuales : []).forEach((m) => agregar(m, r.ia));
    // Paginas que la IA consulto: /api/descargar busca PDFs adentro.
    r.chunks.forEach((c) => agregar({ tipo: "", titulo: c.title || "Resultado de busqueda", url: c.uri }, r.ia));
    // Resultados de busqueda directa que parecen PDF de manual.
    r.resultados.forEach((x) => {
      const t = (x.titulo + " " + x.url).toLowerCase();
      if (!/\.pdf|manual|service|parts|despiece/.test(t)) return;
      const tipo = /service|servicio|tecnico|técnico|repair/.test(t) ? "tecnico" : /parts|spare|despiece|repuesto/.test(t) ? "despiece" : /user|operat|usuario|instruc/.test(t) ? "usuario" : "";
      agregar({ tipo, titulo: x.titulo, url: x.url }, r.ia);
    });
    if (!info && (d.marca || d.modelo)) info = d;
    (Array.isArray(d.insumos) ? d.insumos : []).forEach((x) => x && !insumos.some((i) => i.toLowerCase() === String(x).toLowerCase()) && insumos.push(String(x)));
    (Array.isArray(d.repuestos) ? d.repuestos : []).forEach((x) => {
      if (!x || !x.nombre) return;
      const clave = (x.codigo || x.nombre).toString().toLowerCase();
      if (!repuestos.some((r2) => (r2.codigo || r2.nombre).toLowerCase() === clave)) repuestos.push({ nombre: String(x.nombre), codigo: x.codigo ? String(x.codigo) : "", ia: r.ia });
    });
    (Array.isArray(d.videos) ? d.videos : []).forEach((v) => v && v.url && !videos.some((w) => w.url === v.url) && videos.push(v));
    resumen.push({ ia: r.ia, ok: true, links: porUrl.size - antes });
  });

  if (!resumen.some((r) => r.ok)) throw fail(502, resumen.map((r) => r.error).join(" · "));

  // Primero los links que sugirieron varias IAs.
  const manuales = [...porUrl.values()].sort((a, b) => b.ias.length - a.ias.length);
  info = info || {};

  // Diagnostico: si ninguna IA encontro un solo link, casi siempre es porque
  // ninguna tiene busqueda web real funcionando (Gemini sin facturacion
  // habilitada = grounding sin cupo, y sin Grok/DeepSeek de respaldo).
  let aviso = "";
  if (manuales.length === 0) {
    const usaronWeb = resumen.filter((r) => r.ok);
    aviso = usaronWeb.length
      ? "Ninguna IA encontró links reales de manuales. Con solo Gemini configurado esto pasa cuando el proyecto de Google Cloud de la clave no tiene facturación habilitada (la búsqueda en Google dentro de Gemini no tiene cupo gratis). Solución: habilitá facturación en ese proyecto (igual sigue siendo casi gratis) o agregá Grok en Configuración, que trae su propia búsqueda."
      : "";
  }

  send(res, 200, {
    nombre: info.nombre || nombre,
    marca: info.marca || "",
    modelo: info.modelo || "",
    tipoEquipo: info.tipoEquipo || "",
    manuales,
    videos,
    insumos,
    repuestos,
    ias: resumen,
    aviso,
  });
});
