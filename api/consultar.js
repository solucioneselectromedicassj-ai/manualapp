// POST {equipo:{nombre,marca,modelo,manuales}, pregunta, historial}
// Responde usando los PDFs guardados en Drive. Si el equipo no tiene
// manuales en Drive, responde con busqueda web y lo aclara.
const { handler, send, fail, gemini, driveToken, geminiUriForDrive } = require("./_lib");

const ORDEN = { tecnico: 0, usuario: 1, despiece: 2 };

module.exports = handler(async (req, res, cfg) => {
  const { equipo = {}, pregunta = "", historial = [] } = req.body || {};
  if (!pregunta.trim()) throw fail(400, "falta pregunta");
  const nombreEq = [equipo.nombre, equipo.marca, equipo.modelo].filter(Boolean).join(" ");
  const manuales = (equipo.manuales || [])
    .filter((m) => m.driveId)
    .sort((a, b) => (ORDEN[a.tipo] ?? 9) - (ORDEN[b.tipo] ?? 9))
    .slice(0, 3);

  const previos = (Array.isArray(historial) ? historial : []).slice(-6).map((m) => ({
    role: m.rol === "user" ? "user" : "model",
    parts: [{ text: String(m.texto || "") }],
  }));

  if (manuales.length) {
    const token = await driveToken(cfg);
    const partes = [];
    for (const m of manuales) {
      const uri = await geminiUriForDrive(cfg, token, m.driveId, m.titulo);
      partes.push({ text: `Documento: "${m.titulo}" (${m.tipo || "manual"})` });
      partes.push({ file_data: { mime_type: "application/pdf", file_uri: uri } });
    }
    partes.push({ text: pregunta });
    const { text } = await gemini(cfg, {
      systemInstruction: {
        parts: [
          {
            text: `Sos un asistente tecnico de ingenieria biomedica para el equipo ${nombreEq}. Respondé en español, claro y paso a paso, basandote SOLO en los manuales adjuntos. Citá al final el documento y la pagina: (Fuente: <titulo>, pág. N). Si el manual no lo dice, decilo explicitamente y sugeri que buscar.`,
          },
        ],
      },
      contents: [...previos, { role: "user", parts: partes }],
      generationConfig: { temperature: 0.2 },
    });
    return send(res, 200, {
      respuesta: text,
      modo: "manual",
      fuentes: manuales.map((m) => ({ titulo: m.titulo, url: m.driveLink || m.url })),
    });
  }

  const { text, chunks } = await gemini(cfg, {
    systemInstruction: {
      parts: [{ text: `Sos un asistente tecnico de ingenieria biomedica para el equipo ${nombreEq}. Respondé en español. Aclaralo si la informacion no proviene del manual oficial.` }],
    },
    contents: [...previos, { role: "user", parts: [{ text: pregunta }] }],
    tools: [{ google_search: {} }],
    generationConfig: { temperature: 0.2 },
  });
  send(res, 200, {
    respuesta: text,
    modo: "web",
    fuentes: chunks.slice(0, 5).map((c) => ({ titulo: c.title, url: c.uri })),
  });
});
