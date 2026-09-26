// Biblioteca de equipos guardada como equipos.json en la carpeta de Drive.
// GET -> lista | POST {equipo} -> alta/actualizacion | DELETE ?id= -> baja
const { handler, send, fail, driveToken, driveFolder, driveFindByName, driveDownload, driveUpload } = require("./_lib");

const NOMBRE = "equipos.json";

async function leer(token, folderId) {
  const f = await driveFindByName(token, folderId, NOMBRE);
  if (!f) return { fileId: null, lista: [] };
  const buf = await driveDownload(token, f.id);
  let lista = [];
  try {
    lista = JSON.parse(buf.toString("utf8"));
  } catch (e) {}
  return { fileId: f.id, lista: Array.isArray(lista) ? lista : [] };
}

async function escribir(token, folderId, fileId, lista) {
  const buffer = Buffer.from(JSON.stringify(lista, null, 1), "utf8");
  await driveUpload(token, { folderId, fileId, name: NOMBRE, mime: "application/json", buffer });
}

module.exports = handler(async (req, res, cfg) => {
  const token = await driveToken(cfg);
  const folderId = await driveFolder(token, cfg);
  const { fileId, lista } = await leer(token, folderId);

  if (req.method === "GET") return send(res, 200, { equipos: lista, folderId });

  if (req.method === "POST") {
    const eq = req.body && req.body.equipo;
    if (!eq || !eq.id || !eq.nombre) throw fail(400, "equipo invalido");
    const i = lista.findIndex((e) => e.id === eq.id);
    if (i >= 0) lista[i] = eq;
    else lista.push(eq);
    await escribir(token, folderId, fileId, lista);
    return send(res, 200, { ok: true });
  }

  if (req.method === "DELETE") {
    const id = new URL(req.url, "http://x").searchParams.get("id");
    await escribir(token, folderId, fileId, lista.filter((e) => e.id !== id));
    return send(res, 200, { ok: true });
  }

  throw fail(405, "metodo no permitido");
});
