// POST {equipo:{nombre,marca,modelo,manuales}, pregunta, historial}
// Responde usando los PDFs guardados en Drive. Si el equipo no tiene
// manuales en Drive, responde con busqueda web y lo aclara.
const { handler, send, fail, gemini, preguntarPrimera, preguntarTodas, preguntarIA, elegirMejor, iasDisponibles, geminiUriForManual } = require("./_lib");

const ORDEN = { tecnico: 0, usuario: 1, despiece: 2 };

module.exports = handler(async (req, res, cfg) => {
  const { equipo = {}, pregunta = "", historial = [], comparar = false } = req.body || {};
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
  const sistemaManual = `Sos un asistente tecnico de ingenieria biomedica para el equipo ${nombreEq}. Respondé en español, claro y paso a paso, basandote SOLO en los manuales adjuntos. Citá al final el documento y la pagina: (Fuente: <titulo>, pág. N). Si el manual no lo dice, decilo explicitamente y sugeri que buscar.${extra}`;
  const sistemaWeb = `Sos un asistente tecnico de ingenieria biomedica para el equipo ${nombreEq}. Respondé en español, claro y paso a paso. Citá las fuentes. Aclaralo si la informacion no proviene del manual oficial.${extra}`;
  const fuentesManual = usados.map((m) => ({ titulo: m.titulo, url: m.driveLink || m.url }));

  // Respuesta leyendo los PDFs (solo Gemini puede leer los manuales).
  const conManual = () =>
    gemini(cfg, {
      systemInstruction: { parts: [{ text: sistemaManual }] },
      contents: [...previos, { role: "user", parts: [...partes, { text: pregunta }] }],
      generationConfig: { temperature: 0.2 },
    }).then((r) => ({ ia: "gemini", ok: true, text: r.text, modo: "manual", fuentes: fuentesManual }));

  // Para las IAs de texto la conversacion previa va dentro del mensaje.
  const charla = previos.length ? "Conversacion previa:\n" + previos.map((m) => `${m.role === "user" ? "Tecnico" : "Asistente"}: ${m.parts[0].text}`).join("\n") + "\n\nPregunta actual: " : "";
  const optsWeb = { system: sistemaWeb, prompt: charla + pregunta, web: true, consultas: [`${nombreEq} ${pregunta}`.slice(0, 200)] };
  const aRespuesta = (r) => ({ ia: r.ia, ok: r.ok !== false, text: r.text, error: r.error, modo: "web", fuentes: (r.chunks || []).slice(0, 5).map((c) => ({ titulo: c.title, url: c.uri })) });

  if (!comparar || iasDisponibles(cfg).length < 2) {
    let r;
    if (usados.length) {
      try {
        r = await conManual();
      } catch (e) {
        r = aRespuesta(await preguntarPrimera(cfg, optsWeb)); // Gemini sin cupo: responde otra IA
      }
    } else r = aRespuesta(await preguntarPrimera(cfg, optsWeb));
    return send(res, 200, { respuesta: r.text, modo: r.modo, ia: r.ia, fuentes: r.fuentes });
  }

  // Modo comparar: todas las IAs responden y una jueza elige la mejor.
  const tareas = iasDisponibles(cfg).map((ia) => {
    if (ia === "gemini" && usados.length) return conManual().catch((e) => ({ ia, ok: false, error: e.message }));
    return preguntarIA(cfg, ia, optsWeb, 32000)
      .then(aRespuesta)
      .catch((e) => ({ ia, ok: false, error: e.message }));
  });
  const respuestas = await Promise.all(tareas);
  if (!respuestas.some((r) => r.ok)) throw fail(502, respuestas.map((r) => r.error).join(" · "));
  const { mejor, motivo, juez } = await elegirMejor(cfg, pregunta, respuestas);
  const ganadora = respuestas.find((r) => r.ia === mejor) || respuestas.find((r) => r.ok);
  send(res, 200, {
    respuesta: ganadora.text,
    modo: ganadora.modo,
    ia: ganadora.ia,
    fuentes: ganadora.fuentes,
    comparacion: { mejor: ganadora.ia, motivo, juez, respuestas },
  });
});
