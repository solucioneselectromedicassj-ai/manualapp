// POST {nombre, mime, size} -> crea una sesion de subida resumable en Drive
// para que el navegador suba el PDF directo (sin pasar por el limite de
// 4.5 MB de Vercel). Google habilita CORS para el Origin de la sesion.
const { handler, send, fail, driveToken, driveFolder, driveApi } = require("./_lib");

module.exports = handler(async (req, res, cfg) => {
  const { nombre, mime = "application/pdf", size } = req.body || {};
  if (!nombre) throw fail(400, "falta nombre");
  const token = await driveToken(cfg);
  const folderId = await driveFolder(token, cfg);
  const origin = req.headers.origin || `https://${req.headers.host}`;
  const r = await driveApi(token, "/upload/drive/v3/files?uploadType=resumable&fields=id,name,webViewLink,size", {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=UTF-8",
      "X-Upload-Content-Type": mime,
      ...(size ? { "X-Upload-Content-Length": String(size) } : {}),
      Origin: origin,
    },
    body: JSON.stringify({ name: nombre, parents: [folderId], mimeType: mime }),
  });
  send(res, 200, { uploadUrl: r.headers.get("location") });
});
