// POST {equipo:{nombre,marca,modelo,manuales}, pregunta, historial}
// Responde usando los PDFs guardados en Drive. Si el equipo no tiene
// manuales en Drive, responde con busqueda web y lo aclara.
const { handler, send, fail, gemini, geminiConBusqueda, geminiUriForManual } = require("./_lib");

const ORDEN = { tecnico: 0, usuario: 1, despiece: 2 };

module.exports = handler(async (req, res, cfg) => {
  const { equipo = {}, pregunta = "", historial = [] } = req.body || {};
  if (!pregunta.trim()) throw fail(400, "falta pregunta");
  const nombreEq = [equipo.nombre, equipo.marca, equipo.modelo].filter(Boolean).join(" ");
  // Experiencia propia del equipo tecnico: fallas y reparaciones cargadas a mano.
  const propias = (equipo.fallas || [])
    .filter((f) => f.origen === "propia" || (f.notas || []).length)
    .slice(0, 30)
    .map((f) => `- ${f.falla}: ${[f.solucion, ...(f.notas || []).map((n) => n.texto)].filter(Boolean).join(" / ")}`)
    .join("\n");
  const extra = propias ? `\n\nExperiencia registrada por el equipo tecnico (usala y citala como "registro propio"):\n${propias}` : "";
  const manuales = (equipo.manuales || [])
    .filter((m) => m.driveId || /\.pdf|^https?:/i.test(m.url || ""))
    .sort((a, b) => (ORDEN[a.tipo] ?? 9) - (ORDEN[b.tipo] ?? 9))
    .slice(0, 4);

  const previos = (Array.isArray(historial) ? historial : []).slice(-6).map((m) => ({
    role: m.rol === "user" ? "user" : "model",
    parts: [{ text: String(m.texto || "") }],
  }));

  const partes = [];
  const usados = [];
  if (manuales.length) {
    for (const m of manuales) {
      let uri;
      try {
        uri = await geminiUriForManual(cfg, m);
      } catch (e) {
        continue; // link caido: se sigue con los demas
      }
      usados.push(m);
      partes.push({ text: `Documento: "${m.titulo}" (${m.tipo || "manual"})` });
      partes.push({ file_data: { mime_type: "application/pdf", file_uri: uri } });
    }
  }
  if (usados.length) {
    partes.push({ text: pregunta });
    const { text } = await gemini(cfg, {
      systemInstruction: {
        parts: [
          {
            text: `Sos un asistente tecnico de ingenieria biomedica para el equipo ${nombreEq}. Respondé en español, claro y paso a paso, basandote SOLO en los manuales adjuntos. Citá al final el documento y la pagina: (Fuente: <titulo>, pág. N). Si el manual no lo dice, decilo explicitamente y sugeri que buscar.${extra}`,
          },
        ],
      },
      contents: [...previos, { role: "user", parts: partes }],
      generationConfig: { temperature: 0.2 },
    });
    return send(res, 200, {
      respuesta: text,
      modo: "manual",
      fuentes: usados.map((m) => ({ titulo: m.titulo, url: m.driveLink || m.url })),
    });
  }

  const { text, chunks } = await geminiConBusqueda(cfg, {
    consultas: [`${nombreEq} ${pregunta}`.slice(0, 200)],
    systemInstruction: {
      parts: [{ text: `Sos un asistente tecnico de ingenieria biomedica para el equipo ${nombreEq}. Respondé en español. Aclaralo si la informacion no proviene del manual oficial.${extra}` }],
    },
    contents: [...previos, { role: "user", parts: [{ text: pregunta }] }],
  });
  send(res, 200, {
    respuesta: text,
    modo: "web",
    fuentes: chunks.slice(0, 5).map((c) => ({ titulo: c.title, url: c.uri })),
  });
});
