// GET: que servicios estan configurados (sin revelar claves).
// POST {pin}: verifica el PIN de administrador (env ADMIN_PIN).
const { handler, send, driveToken, driveFolder, iasDisponibles, preguntarIA } = require("./_lib");

module.exports = handler(async (req, res, cfg) => {
  const adminPin = process.env.ADMIN_PIN || "";
  if (req.method === "POST") {
    const pin = ((req.body && req.body.pin) || "").toString();
    return send(res, 200, { ok: !!adminPin && pin === adminPin });
  }
  let drive = false;
  let driveError = "";
  if (cfg.clientId && cfg.clientSecret && cfg.refreshToken) {
    try {
      const token = await driveToken(cfg);
      await driveFolder(token, cfg);
      drive = true;
    } catch (e) {
      driveError = e.message;
    }
  }
  // ?probar=1 hace una llamada minima a cada IA para verificar la clave.
  const pruebas = {};
  if (/[?&]probar=1/.test(req.url || "")) {
    await Promise.all(
      iasDisponibles(cfg).map((ia) =>
        preguntarIA(cfg, ia, { prompt: "Respondé solo: ok" }, 20000)
          .then(() => (pruebas[ia] = { ok: true }))
          .catch((e) => (pruebas[ia] = { ok: false, error: e.message }))
      )
    );
  }
  send(res, 200, {
    pinServidor: !!adminPin,
    grok: !!cfg.grokKey,
    grokModel: cfg.grokModel,
    deepseek: !!cfg.deepseekKey,
    deepseekModel: cfg.deepseekModel,
    pruebas,
    gemini: !!cfg.geminiKey,
    geminiModel: cfg.geminiModel,
    youtube: !!cfg.youtubeKey,
    driveCliente: !!(cfg.clientId && cfg.clientSecret),
    drive,
    driveError,
  });
});
