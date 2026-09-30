// POST {equipo:{nombre,marca,modelo}, driveId?, url?, titulo?}
// Codigo de acceso al modo de servicio/configuracion (distinto de los
// codigos de error): como llegar a la pantalla donde se tipea la clave, y
// una lista de codigos conocidos para probar (de fabrica, genericos que
// circulan entre tecnicos, o los que trae el manual de servicio).
const { handler, send, fail, gemini, preguntarTodas, parseJson, geminiUriForManual } = require("./_lib");

const FORMATO = `Respondé SOLO JSON:
{"pasos":"pasos concretos, numerados en texto, para llegar a la pantalla donde se ingresa el codigo/clave de servicio (menu, combinacion de botones, etc.)",
"codigos":[{"codigo":"el codigo o clave","nota":"de donde sale / para que sirve (ej: clave de fabrica, service password, ingenieria)"}]}
Incluí los codigos por defecto de fabrica y los que circulan entre tecnicos en foros para esta marca/modelo (a veces son genericos y sirven en varias unidades del mismo fabricante). Si no encontrás nada confiable, dejá "codigos" vacio y decilo en "pasos". Máximo 10 codigos, en español.`;

function limpiar(d, fuente) {
  const pasos = d && d.pasos ? String(d.pasos) : "";
  const codigos = ((d && d.codigos) || [])
    .filter((c) => c && c.codigo)
    .map((c) => ({ codigo: String(c.codigo), nota: c.nota ? String(c.nota) : "", origen: fuente }));
  return { pasos, codigos };
}

module.exports = handler(async (req, res, cfg) => {
  const { equipo = {}, driveId, url, titulo = "" } = req.body || {};
  const nombre = [equipo.nombre, equipo.marca, equipo.modelo].filter(Boolean).join(" ");
  if (!nombre) throw fail(400, "falta equipo");

  const web = preguntarTodas(
    cfg,
    {
      prompt: `Sos tecnico de ingenieria biomedica. Buscá en internet (manuales, foros de biomedicos, grupos tecnicos) cómo entrar al modo de servicio / configuración / ingeniería del equipo medico "${nombre}", y los codigos de acceso (clave de fabrica o genericos conocidos) para ese modo. ${FORMATO}`,
      web: true,
      consultas: [`${nombre} service mode access code password`, `${nombre} engineering mode default password`, `${nombre} clave de servicio codigo de acceso`],
    },
    42000
  ).then((rs) => {
    const ok = rs.filter((r) => r.ok);
    if (!ok.length) throw new Error(rs.map((r) => r.error).join(" · "));
    const pasos = [];
    const codigos = [];
    const vistos = new Set();
    ok.forEach((r) => {
      const d = limpiar(parseJson(r.text), r.ia);
      if (d.pasos) pasos.push({ ia: r.ia, texto: d.pasos });
      d.codigos.forEach((c) => {
        const clave = c.codigo.toLowerCase().trim();
        const ya = codigos.find((x) => x.codigo.toLowerCase().trim() === clave);
        if (ya) {
          if (!ya.ias.includes(r.ia)) ya.ias.push(r.ia);
        } else if (!vistos.has(clave)) {
          vistos.add(clave);
          codigos.push({ ...c, ias: [r.ia] });
        }
      });
    });
    return {
      pasos,
      codigos: codigos.sort((a, b) => b.ias.length - a.ias.length).slice(0, 15),
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
                  { text: `De este manual de "${nombre}", buscá la sección de modo de servicio / configuración avanzada / ingeniería (service mode / setup password / engineering mode) y sacá cómo se accede y el codigo o clave, si el manual lo indica. ${FORMATO}` },
                ],
              },
            ],
            generationConfig: { temperature: 0.1, responseMimeType: "application/json" },
          })
        )
        .then((r) => {
          const d = limpiar(parseJson(r.text), "manual");
          return { pasos: d.pasos ? { ia: "gemini", texto: d.pasos, deManual: true } : null, codigos: d.codigos.map((c) => ({ ...c, ias: ["gemini"] })) };
        })
    : Promise.resolve({ pasos: null, codigos: [] });

  const [w, m] = await Promise.allSettled([web, manual]);
  if (w.status === "rejected" && m.status === "rejected") throw w.reason;
  const wv = w.status === "fulfilled" ? w.value : { pasos: [], codigos: [], fuentes: [], ias: [] };
  const mv = m.status === "fulfilled" ? m.value : { pasos: null, codigos: [] };

  send(res, 200, {
    pasos: [...(mv.pasos ? [mv.pasos] : []), ...wv.pasos],
    codigos: [...mv.codigos, ...wv.codigos],
    fuentes: wv.fuentes,
    ias: wv.ias,
    avisos: [w, m].filter((x) => x.status === "rejected").map((x) => x.reason.message),
  });
});
