// POST {nombre} -> busca en internet (Gemini + Google Search) los manuales
// del equipo y devuelve candidatos. Los links se validan despues en
// /api/descargar (que se queda solo con PDFs reales).
const { handler, send, fail, geminiConBusqueda, parseJson } = require("./_lib");

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

module.exports = handler(async (req, res, cfg) => {
  const nombre = ((req.body && req.body.nombre) || "").toString().trim();
  if (!nombre) throw fail(400, "falta nombre");

  const { text, chunks, resultados } = await geminiConBusqueda(cfg, {
    contents: [{ role: "user", parts: [{ text: PROMPT(nombre) }] }],
    consultas: [
      `${nombre} service manual pdf`,
      `${nombre} user manual pdf`,
      `${nombre} operator's manual filetype:pdf`,
      `${nombre} parts list spare parts pdf`,
      `${nombre} manual de servicio pdf`,
    ],
  });
  const data = parseJson(text) || {};

  const manuales = (Array.isArray(data.manuales) ? data.manuales : []).filter((m) => m && /^https?:\/\//.test(m.url || ""));
  // Las paginas que uso Google Search tambien sirven de candidatas: /api/descargar
  // busca links .pdf adentro de cada pagina.
  const vistos = new Set(manuales.map((m) => m.url));
  chunks.forEach((c) => {
    if (c.uri && !vistos.has(c.uri)) {
      vistos.add(c.uri);
      manuales.push({ tipo: "", titulo: c.title || "Resultado de busqueda", url: c.uri, fuente: c.title || "" });
    }
  });

  // Resultados de busqueda directa (sin grounding): los que parecen PDF de
  // manual se suman como candidatos, clasificados por palabras clave.
  resultados.forEach((x) => {
    if (vistos.has(x.url)) return;
    const t = (x.titulo + " " + x.url).toLowerCase();
    if (!/\.pdf|manual|service|parts|despiece/.test(t)) return;
    vistos.add(x.url);
    const tipo = /service|servicio|tecnico|técnico|repair/.test(t) ? "tecnico" : /parts|spare|despiece|repuesto/.test(t) ? "despiece" : /user|operat|usuario|instruc/.test(t) ? "usuario" : "";
    manuales.push({ tipo, titulo: x.titulo, url: x.url, fuente: (x.url.match(/\/\/(?:www\.)?([^/]+)/) || [])[1] || "" });
  });

  send(res, 200, {
    nombre: data.nombre || nombre,
    marca: data.marca || "",
    modelo: data.modelo || "",
    tipoEquipo: data.tipoEquipo || "",
    manuales,
    videos: (Array.isArray(data.videos) ? data.videos : []).filter((v) => v && v.url),
    insumos: (Array.isArray(data.insumos) ? data.insumos : []).filter(Boolean).map(String),
    repuestos: (Array.isArray(data.repuestos) ? data.repuestos : [])
      .filter((r) => r && r.nombre)
      .map((r) => ({ nombre: String(r.nombre), codigo: r.codigo ? String(r.codigo) : "" })),
  });
});
