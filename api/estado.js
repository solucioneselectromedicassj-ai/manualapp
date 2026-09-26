// GET: que servicios estan configurados (sin revelar claves).
// POST {pin}: verifica el PIN de administrador (env ADMIN_PIN).
const { handler, send, driveToken, driveFolder } = require("./_lib");

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
  send(res, 200, {
    pinServidor: !!adminPin,
    gemini: !!cfg.geminiKey,
    geminiModel: cfg.geminiModel,
    youtube: !!cfg.youtubeKey,
    driveCliente: !!(cfg.clientId && cfg.clientSecret),
    drive,
    driveError,
  });
});
