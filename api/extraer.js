// POST {driveId, titulo, equipo} -> lee el PDF desde Drive con Gemini y
// devuelve insumos y repuestos (con codigo si figura en el manual).
const { handler, send, fail, gemini, parseJson, driveToken, geminiUriForDrive } = require("./_lib");

module.exports = handler(async (req, res, cfg) => {
  const { driveId, titulo = "", equipo = "" } = req.body || {};
  if (!driveId) throw fail(400, "falta driveId");
  const token = await driveToken(cfg);
  const uri = await geminiUriForDrive(cfg, token, driveId, titulo);
  const { text } = await gemini(cfg, {
    contents: [
      {
        role: "user",
        parts: [
          { file_data: { mime_type: "application/pdf", file_uri: uri } },
          {
            text: `Este es un manual del equipo "${equipo}". Extraé:
- insumos: accesorios y consumibles (sensores, cables, manguitos, electrodos, papel, filtros, etc.)
- repuestos: partes reemplazables con su codigo / part number / order number tal como figura en el manual.
Respondé solo JSON: {"insumos":[{"nombre":"","codigo":"","pagina":0}],"repuestos":[{"nombre":"","codigo":"","pagina":0}]}. Maximo 40 de cada uno.`,
          },
        ],
      },
    ],
    generationConfig: { temperature: 0.1, responseMimeType: "application/json" },
  });
  const d = parseJson(text) || {};
  const limpiar = (arr) =>
    (Array.isArray(arr) ? arr : [])
      .filter((x) => x && x.nombre)
      .map((x) => ({ nombre: String(x.nombre), codigo: x.codigo ? String(x.codigo) : "", pagina: x.pagina || null }));
  send(res, 200, { insumos: limpiar(d.insumos), repuestos: limpiar(d.repuestos) });
});
