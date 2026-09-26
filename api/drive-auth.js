// Conexion de Google Drive (una sola vez).
// 1) /api/drive-auth           -> redirige al consentimiento de Google
// 2) Google vuelve con ?code=  -> se canjea por un refresh token y se muestra
//    para copiarlo a la variable GOOGLE_REFRESH_TOKEN de Vercel (o guardarlo
//    en este navegador desde el mismo boton).
const { handler, send } = require("./_lib");

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function page(res, body) {
  res.status(200).setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(`<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Conectar Drive</title><style>body{font-family:system-ui,sans-serif;background:#f4f7fb;color:#0f172a;max-width:640px;margin:0 auto;padding:24px 16px}
code,textarea{width:100%;font-family:monospace;font-size:13px}textarea{height:90px;padding:8px;border:1px solid #cbd5e1;border-radius:8px}
button,a.btn{display:inline-block;background:#0284c7;color:#fff;border:0;padding:10px 16px;border-radius:8px;font-weight:600;cursor:pointer;text-decoration:none;margin-top:10px}
.box{background:#fff;border:1px solid #dbe3ee;border-radius:12px;padding:18px}</style></head><body><div class="box">${body}</div></body></html>`);
}

module.exports = handler(async (req, res, cfg) => {
  if (!cfg.clientId || !cfg.clientSecret) {
    return page(res, `<h2>Falta configurar Google OAuth</h2><p>Cargá <b>GOOGLE_CLIENT_ID</b> y <b>GOOGLE_CLIENT_SECRET</b> en las variables de entorno de Vercel y volvé a desplegar. Los pasos están en el README.</p>`);
  }
  const proto = req.headers["x-forwarded-proto"] || "https";
  const redirectUri = `${proto}://${req.headers.host}/api/drive-auth`;
  const url = new URL(req.url, redirectUri);
  const code = url.searchParams.get("code");
  const err = url.searchParams.get("error");

  if (err) return page(res, `<h2>Google rechazó la conexión</h2><p>${esc(err)}</p><a class="btn" href="/api/drive-auth">Reintentar</a>`);

  if (!code) {
    const auth = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    auth.search = new URLSearchParams({
      client_id: cfg.clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "https://www.googleapis.com/auth/drive.file",
      access_type: "offline",
      prompt: "consent",
    }).toString();
    res.statusCode = 302;
    res.setHeader("Location", auth.toString());
    return res.end();
  }

  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });
  const j = await r.json();
  if (!r.ok || !j.refresh_token) {
    return page(res, `<h2>No se obtuvo el refresh token</h2><p>${esc(j.error_description || j.error || "Google no devolvió refresh_token")}</p><a class="btn" href="/api/drive-auth">Reintentar</a>`);
  }
  const tok = esc(j.refresh_token);
  page(res, `<h2>✓ Drive conectado</h2>
<p>Para que quede fijo para todos, copiá este valor en la variable <b>GOOGLE_REFRESH_TOKEN</b> de Vercel y redeployá:</p>
<textarea readonly id="t">${tok}</textarea>
<p>O guardalo solo en este navegador:</p>
<button onclick="try{var c=JSON.parse(localStorage.getItem('msem.cfg')||'{}');c.refreshToken=document.getElementById('t').value;localStorage.setItem('msem.cfg',JSON.stringify(c));location.href='/'}catch(e){alert(e)}">Guardar en este navegador y volver</button>`);
});
