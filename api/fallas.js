// POST {equipo:{nombre,marca,modelo}, driveId?, titulo?}
// Fallas mas comunes y como repararlas: del manual (seccion de solucion de
// problemas / codigos de error) y de la web (foros, videos, service notes).
const { handler, send, fail, gemini, preguntarTodas, parseJson, geminiUriForManual } = require("./_lib");

const FORMATO = `Respondé solo JSON: {"fallas":[{"codigo":"codigo de error que muestra el equipo en pantalla, si tiene (ej: Err 12, E-04, Alarm 3); dejar \"\" si no hay codigo","falla":"sintoma o mensaje de error","causas":"causas probables","solucion":"pasos de reparacion concretos","pagina":0}]}. Entre 5 y 15 fallas, las mas frecuentes primero, en español.`

function limpiar(d, fuente) {
  return ((d && d.fallas) || [])
    .filter((f) => f && f.falla)
    .map((f) => ({
      codigo: f.codigo ? String(f.codigo) : "",
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

  // Todas las IAs configuradas buscan en paralelo; cada falla queda marcada
  // con la IA que la aporto. Las repetidas se unen.
  const web = preguntarTodas(
    cfg,
    {
      prompt: `Buscá en internet (foros de biomedicos, service notes, videos, grupos tecnicos) las fallas mas comunes del equipo medico "${nombre}" y como se reparan. ${FORMATO}`,
      web: true,
      consultas: [`${nombre} troubleshooting error codes`, `${nombre} common problems repair`, `${nombre} falla reparacion`],
    },
    42000
  ).then((rs) => {
    const fallas = [];
    const clave = (t) => t.toLowerCase().replace(/[^a-z0-9áéíóúñ]+/g, " ").trim().slice(0, 40);
    rs.filter((r) => r.ok).forEach((r) =>
      limpiar(parseJson(r.text), "web").forEach((f) => {
        const ya = fallas.find((x) => clave(x.falla) === clave(f.falla));
        if (ya) {
          if (!ya.ias.includes(r.ia)) ya.ias.push(r.ia);
        } else fallas.push({ ...f, ias: [r.ia] });
      })
    );
    if (!rs.some((r) => r.ok)) throw new Error(rs.map((r) => r.error).join(" · "));
    return {
      fallas: fallas.sort((x, y) => y.ias.length - x.ias.length).slice(0, 20),
      fuentes: rs.flatMap((r) => (r.chunks || []).slice(0, 3)).map((c) => ({ titulo: c.title, url: c.uri })),
      ias: rs.map((r) => ({ ia: r.ia, ok: r.ok, error: r.error })),
    };
  });

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
        .then((r) => limpiar(parseJson(r.text), "manual").map((f) => ({ ...f, ias: ["gemini"] })))
    : Promise.resolve([]);

  const [w, m] = await Promise.allSettled([web, manual]);
  if (w.status === "rejected" && m.status === "rejected") throw w.reason;
  send(res, 200, {
    fallas: [...(m.status === "fulfilled" ? m.value : []), ...(w.status === "fulfilled" ? w.value.fallas : [])],
    fuentes: w.status === "fulfilled" ? w.value.fuentes : [],
    ias: w.status === "fulfilled" ? w.value.ias : [],
    avisos: [w, m].filter((x) => x.status === "rejected").map((x) => x.reason.message),
  });
});
