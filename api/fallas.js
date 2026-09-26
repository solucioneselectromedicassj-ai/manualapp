// POST {equipo:{nombre,marca,modelo}, driveId?, titulo?}
// Fallas mas comunes y como repararlas: del manual (seccion de solucion de
// problemas / codigos de error) y de la web (foros, videos, service notes).
const { handler, send, fail, gemini, geminiConBusqueda, parseJson, geminiUriForManual } = require("./_lib");

const FORMATO = `Respondé solo JSON: {"fallas":[{"falla":"sintoma o mensaje de error","causas":"causas probables","solucion":"pasos de reparacion concretos","pagina":0}]}. Entre 5 y 15 fallas, las mas frecuentes primero, en español.`;

function limpiar(d, fuente) {
  return ((d && d.fallas) || [])
    .filter((f) => f && f.falla)
    .map((f) => ({
      falla: String(f.falla),
      causas: f.causas ? String(f.causas) : "",
      solucion: f.solucion ? String(f.solucion) : "",
      pagina: f.pagina || null,
      origen: fuente,
    }));
}

module.exports = handler(async (req, res, cfg) => {
  const { equipo = {}, driveId, url, titulo = "" } = req.body || {};
  const nombre = [equipo.nombre, equipo.marca, equipo.modelo].filter(Boolean).join(" ");
  if (!nombre) throw fail(400, "falta equipo");

  const web = geminiConBusqueda(cfg, {
    consultas: [`${nombre} troubleshooting error codes`, `${nombre} common problems repair`, `${nombre} falla reparacion`],
    contents: [
      {
        role: "user",
        parts: [{ text: `Buscá en internet (foros de biomedicos, service notes, videos, grupos tecnicos) las fallas mas comunes del equipo medico "${nombre}" y como se reparan. ${FORMATO}` }],
      },
    ],
  }).then((r) => ({ fallas: limpiar(parseJson(r.text), "web"), fuentes: r.chunks.slice(0, 5).map((c) => ({ titulo: c.title, url: c.uri })) }));

  const manual = driveId || url
    ? geminiUriForManual(cfg, { driveId, url, titulo })
        .then((uri) =>
          gemini(cfg, {
            contents: [
              {
                role: "user",
                parts: [
                  { file_data: { mime_type: "application/pdf", file_uri: uri } },
                  { text: `De este manual de "${nombre}", sacá las fallas de la seccion de solucion de problemas / troubleshooting / mensajes de alarma y error, con su solucion. Indicá la pagina. ${FORMATO}` },
                ],
              },
            ],
            generationConfig: { temperature: 0.1, responseMimeType: "application/json" },
          })
        )
        .then((r) => limpiar(parseJson(r.text), "manual"))
    : Promise.resolve([]);

  const [w, m] = await Promise.allSettled([web, manual]);
  if (w.status === "rejected" && m.status === "rejected") throw w.reason;
  send(res, 200, {
    fallas: [...(m.status === "fulfilled" ? m.value : []), ...(w.status === "fulfilled" ? w.value.fallas : [])],
    fuentes: w.status === "fulfilled" ? w.value.fuentes : [],
    avisos: [w, m].filter((x) => x.status === "rejected").map((x) => x.reason.message),
  });
});
