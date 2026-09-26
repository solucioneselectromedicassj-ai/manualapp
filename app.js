const { useState, useEffect, useRef, useMemo } = React;

// ---------------------------------------------------------------------------
// CONFIG LOCAL (panel de Configuracion)
// ---------------------------------------------------------------------------
// Las claves van preferentemente en las variables de entorno de Vercel. Lo que
// se cargue en el panel queda solo en este navegador y viaja por headers a
// /api/* (tiene prioridad sobre las de Vercel).
const LS_CFG = "msem.cfg";
const LS_EQUIPOS = "msem.equipos";
const LS_PIN = "msem.pinHash";

function leerLS(k, def) {
  try {
    const v = localStorage.getItem(k);
    return v ? JSON.parse(v) : def;
  } catch (e) {
    return def;
  }
}
function guardarLS(k, v) {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch (e) {}
}

function headersCfg() {
  const c = leerLS(LS_CFG, {});
  const h = { "Content-Type": "application/json" };
  if (c.geminiKey) h["x-gemini-key"] = c.geminiKey;
  if (c.geminiModel) h["x-gemini-model"] = c.geminiModel;
  if (c.youtubeKey) h["x-youtube-key"] = c.youtubeKey;
  if (c.grokKey) h["x-grok-key"] = c.grokKey;
  if (c.deepseekKey) h["x-deepseek-key"] = c.deepseekKey;
  if (c.refreshToken) h["x-google-refresh-token"] = c.refreshToken;
  if (c.folderId) h["x-drive-folder"] = c.folderId;
  return h;
}

async function api(path, body, method) {
  const res = await fetch("/api/" + path, {
    method: method || (body ? "POST" : "GET"),
    headers: headersCfg(),
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try {
    data = await res.json();
  } catch (e) {
    throw new Error(res.status === 404 ? "El backend /api no esta desplegado" : "Respuesta invalida del servidor (" + res.status + ")");
  }
  if (!res.ok) throw new Error(data.error || "Error " + res.status);
  return data;
}

async function sha256(txt) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(txt));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

const IAS = { gemini: "Gemini", grok: "Grok", deepseek: "DeepSeek" };
const nombresIA = (ias) => (ias || []).map((i) => IAS[i] || i).join(" + ");

// Ranking: cuantos links sugirio cada IA y cuantos resultaron PDFs reales.
function rankingIAs(equipos) {
  const t = {};
  Object.keys(IAS).forEach((k) => (t[k] = { sugeridos: 0, validos: 0, fallas: 0, consultas: 0 }));
  equipos.forEach((e) => {
    (e.candidatos || []).forEach((c) => (c.ias || []).forEach((i) => t[i] && t[i].sugeridos++));
    (e.manuales || []).forEach((m) => (m.ias || []).forEach((i) => t[i] && t[i].validos++));
    (e.fallas || []).forEach((f) => (f.ias || []).forEach((i) => t[i] && t[i].fallas++));
    Object.entries(e.consultasGanadas || {}).forEach(([i, n]) => t[i] && (t[i].consultas += n));
  });
  return t;
}

const TIPOS = { usuario: "Manual de usuario", tecnico: "Manual técnico", despiece: "Manual de despiece" };

// ---------------------------------------------------------------------------
// BIBLIOTECA: equipos.json en Drive, con copia en este navegador
// ---------------------------------------------------------------------------
function useEquipos() {
  const [equipos, setEquipos] = useState(() => leerLS(LS_EQUIPOS, []));
  const [enDrive, setEnDrive] = useState(false);
  const [cargando, setCargando] = useState(true);

  const recargar = async () => {
    try {
      const r = await api("equipos");
      setEquipos(r.equipos);
      guardarLS(LS_EQUIPOS, r.equipos);
      setEnDrive(true);
    } catch (e) {
      setEnDrive(false);
    }
    setCargando(false);
  };

  useEffect(() => {
    recargar();
  }, []);

  const guardar = async (equipo) => {
    setEquipos((prev) => {
      const next = prev.some((e) => e.id === equipo.id) ? prev.map((e) => (e.id === equipo.id ? equipo : e)) : [...prev, equipo];
      guardarLS(LS_EQUIPOS, next);
      return next;
    });
    if (enDrive) {
      try {
        await api("equipos", { equipo });
      } catch (e) {
        console.warn("No se guardo en Drive:", e.message);
      }
    }
  };

  const borrar = async (id) => {
    setEquipos((prev) => {
      const next = prev.filter((e) => e.id !== id);
      guardarLS(LS_EQUIPOS, next);
      return next;
    });
    if (enDrive) await api("equipos?id=" + encodeURIComponent(id), null, "DELETE").catch(() => {});
  };

  return { equipos, enDrive, cargando, guardar, borrar, recargar };
}

// Detecta repuestos con el mismo nombre/codigo en otros equipos, para el
// aviso de "repuesto compartido entre marcas/modelos".
function detectarRepuestosCompartidos(equipoActual, todosLosEquipos) {
  const alertas = {};
  (equipoActual.repuestos || []).forEach((rep) => {
    const compartidoEn = todosLosEquipos
      .filter((e) => e.id !== equipoActual.id)
      .filter((e) =>
        (e.repuestos || []).some(
          (r) =>
            (rep.codigo && r.codigo && r.codigo === rep.codigo) ||
            r.nombre.toLowerCase().trim() === rep.nombre.toLowerCase().trim()
        )
      )
      .map((e) => `${e.marca || ""} ${e.modelo || e.nombre}`.trim());
    if (compartidoEn.length) alertas[rep.nombre] = compartidoEn;
  });
  return alertas;
}

function unirItems(actuales, nuevos) {
  const out = [...(actuales || [])];
  (nuevos || []).forEach((n) => {
    const clave = (n.codigo || n.nombre).toLowerCase().trim();
    if (!out.some((o) => (o.codigo || o.nombre).toLowerCase().trim() === clave)) out.push(n);
  });
  return out;
}

// Sube un archivo (Blob/File) directo del navegador a la carpeta de Drive.
async function subirADrive(blob, nombre) {
  const mime = blob.type || "application/octet-stream";
  const { uploadUrl } = await api("subir", { nombre, mime, size: blob.size });
  const up = await fetch(uploadUrl, { method: "PUT", headers: { "Content-Type": mime }, body: blob });
  if (!up.ok) throw new Error("Drive rechazó la subida (" + up.status + ")");
  const f = await up.json();
  return { driveId: f.id, driveLink: f.webViewLink || `https://drive.google.com/file/d/${f.id}/view` };
}

// Achica una foto: devuelve un JPEG liviano para Drive y una miniatura
// (dataURL de pocos KB) que se guarda en la ficha para verla sin conexion.
function reducirImagen(file, max, calidad) {
  return new Promise((ok, mal) => {
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement("canvas");
      c.width = Math.round(img.width * k);
      c.height = Math.round(img.height * k);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(img.src);
      c.toBlob((b) => ok({ blob: b, dataUrl: max <= 320 ? c.toDataURL("image/jpeg", calidad) : null }), "image/jpeg", calidad);
    };
    img.onerror = () => mal(new Error("No se pudo leer la imagen"));
    img.src = URL.createObjectURL(file);
  });
}

const nombreSeguro = (s) => s.replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim();

// Prueba los candidatos de cada tipo hasta conseguir un PDF real en Drive.
async function descargarManuales(equipo, candidatos, tipos, onPaso) {
  const obtenidos = [];
  const usados = new Set((equipo.manuales || []).map((m) => m.url));
  const sinTipo = candidatos.filter((c) => !c.tipo);
  for (const tipo of tipos) {
    onPaso(tipo, "buscando", "");
    const lista = [...candidatos.filter((c) => c.tipo === tipo), ...sinTipo].filter((c) => !usados.has(c.url)).slice(0, 6);
    let ok = null;
    let ultimo = "sin links candidatos";
    for (const c of lista) {
      onPaso(tipo, "buscando", "probando " + (c.fuente || c.url).slice(0, 50));
      try {
        const r = await api("descargar", { url: c.url, tipo, titulo: c.titulo, equipo: equipo.nombre, modelo: equipo.modelo });
        if (r.ok) {
          ok = { ...r.manual, ias: c.ias || [] };
          usados.add(c.url);
          usados.add(r.manual.url);
          break;
        }
        ultimo = r.motivo;
      } catch (e) {
        ultimo = e.message;
      }
    }
    if (ok) {
      obtenidos.push(ok);
      const por = ok.ias.length ? " · encontrado por " + nombresIA(ok.ias) : "";
      onPaso(tipo, "ok", (ok.driveId ? "guardado en Drive (" + ok.fuente + ")" : "PDF válido (" + ok.fuente + "), falta conectar Drive") + por);
    } else onPaso(tipo, "error", "no se encontró PDF descargable: " + ultimo);
  }
  return obtenidos;
}

// ---------------------------------------------------------------------------
// COMPONENTES
// ---------------------------------------------------------------------------
function Icono({ d, size = 18 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}
const IC = {
  gear: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z",
  download: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3",
  search: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3",
};

function ModalAgregarEquipo({ nombreInicial, onClose, onCreado }) {
  const [pasos, setPasos] = useState([
    { id: "buscar", label: "Buscando el equipo y sus manuales en internet", estado: "pendiente", det: "" },
    { id: "usuario", label: "Manual de usuario → Drive", estado: "pendiente", det: "" },
    { id: "tecnico", label: "Manual técnico → Drive", estado: "pendiente", det: "" },
    { id: "despiece", label: "Manual de despiece → Drive", estado: "pendiente", det: "" },
    { id: "videos", label: "Videos de YouTube", estado: "pendiente", det: "" },
    { id: "extraer", label: "Extrayendo insumos y repuestos del manual", estado: "pendiente", det: "" },
  ]);
  const [equipo, setEquipo] = useState(null);
  const [error, setError] = useState("");
  const [terminado, setTerminado] = useState(false);

  const paso = (id, estado, det) => setPasos((prev) => prev.map((p) => (p.id === id ? { ...p, estado, det: det || "" } : p)));

  useEffect(() => {
    let cancel = false;
    async function run() {
      paso("buscar", "buscando");
      let info;
      try {
        info = await api("buscar", { nombre: nombreInicial });
      } catch (e) {
        paso("buscar", "error", e.message);
        setError(e.message);
        return;
      }
      if (cancel) return;
      const porIA = (info.ias || []).map((r) => `${IAS[r.ia]} ${r.ok ? r.links + " links" : "✕"}`).join(" · ");
      if (info.manuales.length === 0 && info.aviso) {
        paso("buscar", "error", info.aviso);
      } else {
        paso("buscar", "ok", `${[info.marca, info.modelo].filter(Boolean).join(" ") || info.nombre} · ${info.manuales.length} links candidatos${porIA ? " (" + porIA + ")" : ""}`);
      }

      let eq = {
        id: "eq-" + Date.now(),
        nombre: nombreInicial,
        marca: info.marca,
        modelo: info.modelo,
        tipoEquipo: info.tipoEquipo,
        manuales: [],
        candidatos: info.manuales,
        videos: [],
        insumos: info.insumos.map((n) => ({ nombre: n, origen: "web" })),
        repuestos: info.repuestos.map((r) => ({ ...r, origen: "web" })),
        creado: new Date().toISOString(),
      };

      eq.manuales = await descargarManuales(eq, info.manuales, ["usuario", "tecnico", "despiece"], (t, e, d) => !cancel && paso(t, e, d));
      if (cancel) return;

      paso("videos", "buscando");
      try {
        const v = await api("videos", { nombre: [eq.marca, eq.modelo].filter(Boolean).join(" ") || eq.nombre, sugeridos: info.videos });
        eq.videos = v.videos;
        paso("videos", v.videos.length ? "ok" : "error", v.videos.length ? v.videos.length + " videos" + (v.aviso ? " (sin API de YouTube)" : "") : v.aviso || "sin resultados");
      } catch (e) {
        paso("videos", "error", e.message);
      }
      if (cancel) return;

      const base = eq.manuales.find((m) => (m.driveId || m.url) && m.tipo === "despiece") || eq.manuales.find((m) => (m.driveId || m.url) && m.tipo === "tecnico") || eq.manuales.find((m) => m.driveId || m.url);
      if (base) {
        paso("extraer", "buscando", "leyendo " + base.titulo);
        try {
          const x = await api("extraer", { driveId: base.driveId, url: base.url, titulo: base.titulo, equipo: eq.nombre });
          eq.insumos = unirItems(x.insumos.map((i) => ({ ...i, origen: "auto" })), eq.insumos);
          eq.repuestos = unirItems(x.repuestos.map((r) => ({ ...r, origen: "auto" })), eq.repuestos);
          paso("extraer", "ok", `${x.insumos.length} insumos, ${x.repuestos.length} repuestos del manual`);
        } catch (e) {
          paso("extraer", "error", e.message);
        }
      } else paso("extraer", "error", "no se encontró manual para leer (se usan los datos de la web)");

      if (cancel) return;
      setEquipo(eq);
      setTerminado(true);
    }
    run();
    return () => {
      cancel = true;
    };
  }, []);

  return (
    <div className="modal-overlay">
      <div className="modal">
        <button className="close" onClick={onClose} aria-label="Cerrar">×</button>
        <h2>Agregando "{nombreInicial}"</h2>
        <p className="muted small">Busca en internet, se queda solo con PDFs descargables y los guarda en tu Drive. Puede tardar 1–2 minutos.</p>
        <ul className="progress-list">
          {pasos.map((p) => (
            <li key={p.id}>
              {p.estado === "pendiente" && <span className="dot" />}
              {p.estado === "buscando" && <span className="spinner" />}
              {p.estado === "ok" && <span className="check">✓</span>}
              {p.estado === "error" && <span className="fail">!</span>}
              <div>
                <div>{p.label}</div>
                {p.det && <div className="muted small">{p.det}</div>}
              </div>
            </li>
          ))}
        </ul>
        {error && (
          <div className="alert">
            {error}
            <div className="small">Revisá la Configuración (⚙) — falta alguna clave o el backend.</div>
          </div>
        )}
        {terminado && (
          <div className="row-end">
            <button className="btn primary" onClick={() => onCreado(equipo)}>Guardar y abrir ficha</button>
          </div>
        )}
      </div>
    </div>
  );
}

function InlineAdd({ placeholder, onAdd, boton = "Agregar" }) {
  const [val, setVal] = useState("");
  const enviar = () => {
    if (val.trim()) {
      onAdd(val.trim());
      setVal("");
    }
  };
  return (
    <div className="inline-add">
      <input placeholder={placeholder} value={val} onChange={(e) => setVal(e.target.value)} onKeyDown={(e) => e.key === "Enter" && enviar()} />
      <button className="btn" onClick={enviar}>{boton}</button>
    </div>
  );
}

function TabManuales({ equipo, onUpdate }) {
  const [estado, setEstado] = useState("");
  const [ocupado, setOcupado] = useState(false);
  const [tipoNuevo, setTipoNuevo] = useState("tecnico");
  const fileRef = useRef(null);
  const manuales = equipo.manuales || [];
  const faltan = Object.keys(TIPOS).filter((t) => !manuales.some((m) => m.tipo === t && (m.driveId || m.url)));

  const agregarManual = (m) => onUpdate({ manuales: [...manuales, m] });

  const porUrl = async (url) => {
    setOcupado(true);
    setEstado("Descargando y validando PDF…");
    try {
      const r = await api("descargar", { url, tipo: tipoNuevo, titulo: TIPOS[tipoNuevo] + " " + (equipo.modelo || equipo.nombre), equipo: equipo.nombre, modelo: equipo.modelo });
      if (r.ok) {
        agregarManual(r.manual);
        setEstado(r.manual.driveId ? "✓ Guardado en Drive" : r.manual.aviso);
      } else setEstado("✕ " + r.motivo + ". Probá con el link directo al PDF o subí el archivo.");
    } catch (e) {
      setEstado("✕ " + e.message);
    }
    setOcupado(false);
  };

  const subirArchivo = async (file) => {
    if (!file) return;
    setOcupado(true);
    setEstado("Subiendo " + file.name + " a Drive…");
    try {
      const nombre = nombreSeguro(`${equipo.nombre} - ${tipoNuevo} - ${file.name}`.replace(/\.pdf$/i, "")) + ".pdf";
      const d = await subirADrive(file, nombre);
      agregarManual({ tipo: tipoNuevo, titulo: file.name.replace(/\.pdf$/i, ""), url: "", fuente: "subido a mano", tamano: file.size, ...d });
      setEstado("✓ Subido a Drive");
    } catch (e) {
      setEstado("✕ " + e.message);
    }
    setOcupado(false);
    if (fileRef.current) fileRef.current.value = "";
  };

  const reintentar = async () => {
    setOcupado(true);
    setEstado("Buscando de nuevo en internet…");
    try {
      const nombre = [equipo.marca, equipo.modelo].filter(Boolean).join(" ") || equipo.nombre;
      const info = await api("buscar", { nombre });
      const nuevos = await descargarManuales(equipo, info.manuales, faltan, (t, e, d) => setEstado(`${TIPOS[t]}: ${d || e}`));
      onUpdate({ manuales: [...manuales, ...nuevos], candidatos: info.manuales });
      setEstado(nuevos.length ? `✓ ${nuevos.length} manual(es) nuevos en Drive` : "No se encontraron PDFs descargables. Subí el PDF o pegá el link directo.");
    } catch (e) {
      setEstado("✕ " + e.message);
    }
    setOcupado(false);
  };

  const quitar = (i) => {
    if (confirm("¿Quitar este manual de la ficha? (el archivo sigue en Drive)")) onUpdate({ manuales: manuales.filter((_, j) => j !== i) });
  };

  return (
    <div>
      {manuales.length === 0 && <p className="muted">Todavía no hay manuales guardados para este equipo.</p>}
      {manuales.map((m, i) => (
        <div className="link-item" key={i}>
          <div className="grow">
            <a href={m.driveLink || m.url} target="_blank" rel="noreferrer">{m.titulo || TIPOS[m.tipo] || "Manual"}</a>
            <div className="small muted">
              {m.driveId ? "✓ en Drive" : "⚠ solo link externo"}
              {(m.ias || []).length > 0 && " · encontrado por " + nombresIA(m.ias)}
              {m.fuente && " · " + m.fuente}
              {m.tamano ? " · " + (m.tamano / 1048576).toFixed(1) + " MB" : ""}
              {m.url && m.driveLink && (
                <React.Fragment>
                  {" · "}
                  <a href={m.url} target="_blank" rel="noreferrer">origen</a>
                </React.Fragment>
              )}
            </div>
          </div>
          <span className="tag">{TIPOS[m.tipo] || m.tipo || "manual"}</span>
          <button className="icon-btn" title="Quitar" onClick={() => quitar(i)}>×</button>
        </div>
      ))}

      {faltan.length > 0 && (
        <div className="hint">
          Faltan: {faltan.map((t) => TIPOS[t]).join(", ")}.{" "}
          <button className="btn small" disabled={ocupado} onClick={reintentar}>Buscar de nuevo</button>
        </div>
      )}

      <div className="panel-sub">
        <div className="section-title"><h4>Agregar manual a mano</h4></div>
        <p className="small muted">Si el sitio del fabricante no deja descargar (ej. páginas de Mindray que piden login), pegá el link directo al PDF o subí el archivo desde tu teléfono/PC.</p>
        <select value={tipoNuevo} onChange={(e) => setTipoNuevo(e.target.value)}>
          {Object.entries(TIPOS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <InlineAdd placeholder="https://…/manual.pdf" boton="Descargar" onAdd={porUrl} />
        <div className="inline-add">
          <input ref={fileRef} type="file" accept="application/pdf,.pdf" disabled={ocupado} onChange={(e) => subirArchivo(e.target.files[0])} />
        </div>
        {estado && <div className="small estado">{ocupado && <span className="spinner" />} {estado}</div>}
      </div>
    </div>
  );
}

function TabVideos({ equipo, onUpdate }) {
  const [abierto, setAbierto] = useState(null);
  const [estado, setEstado] = useState("");
  const videos = equipo.videos || [];
  const nombre = [equipo.marca, equipo.modelo].filter(Boolean).join(" ") || equipo.nombre;

  const buscar = async () => {
    setEstado("Buscando…");
    try {
      const v = await api("videos", { nombre, sugeridos: videos });
      onUpdate({ videos: unirItems(videos.map((x) => ({ ...x, nombre: x.id })), v.videos.map((x) => ({ ...x, nombre: x.id }))) });
      setEstado(v.aviso || (v.videos.length ? "" : "Sin resultados"));
    } catch (e) {
      setEstado("✕ " + e.message);
    }
  };

  const agregar = (url) => {
    const m = url.match(/(?:v=|youtu\.be\/|embed\/|shorts\/)([\w-]{11})/);
    if (!m) return setEstado("Link de YouTube no válido");
    onUpdate({ videos: [...videos, { id: m[1], titulo: "Video agregado", url: "https://www.youtube.com/watch?v=" + m[1] }] });
  };

  return (
    <div>
      {videos.length === 0 && <p className="muted">Todavía no hay videos para este equipo.</p>}
      <div className="video-grid">
        {videos.map((v, i) => {
          const id = v.id || ((v.url || "").match(/(?:v=|youtu\.be\/|embed\/|shorts\/)([\w-]{11})/) || [])[1];
          if (!id) return null;
          return (
            <div className="video-card" key={id + i}>
              {abierto === id ? (
                <iframe
                  src={`https://www.youtube-nocookie.com/embed/${id}?autoplay=1`}
                  title={v.titulo}
                  allow="accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture"
                  allowFullScreen
                />
              ) : (
                <button className="thumb" onClick={() => setAbierto(id)} style={{ backgroundImage: `url(https://i.ytimg.com/vi/${id}/hqdefault.jpg)` }}>
                  <span className="play">▶</span>
                </button>
              )}
              <div className="video-meta">
                <a href={`https://www.youtube.com/watch?v=${id}`} target="_blank" rel="noreferrer">{v.titulo}</a>
                {v.canal && <div className="small muted">{v.canal}</div>}
              </div>
            </div>
          );
        })}
      </div>
      <div className="row gap wrap mt">
        <button className="btn" onClick={buscar}>Buscar videos</button>
        <a className="btn" href={`https://www.youtube.com/results?search_query=${encodeURIComponent(nombre + " service")}`} target="_blank" rel="noreferrer">Abrir búsqueda en YouTube</a>
      </div>
      <InlineAdd placeholder="Pegar link de YouTube…" onAdd={agregar} />
      {estado && <div className="small muted mt">{estado}</div>}
    </div>
  );
}

function ListaItems({ items, onChange, placeholder, alertas }) {
  return (
    <div>
      {items.length === 0 && <p className="muted">Sin datos cargados todavía.</p>}
      {items.map((it, i) => (
        <div key={i}>
          <div className="item-row">
            <span>
              {it.nombre} {it.codigo && <span className="tag">{it.codigo}</span>}
              {it.pagina ? <span className="small muted"> · pág. {it.pagina}</span> : null}
            </span>
            <span className="row gap">
              <span className="origen">{it.origen === "auto" ? "del manual" : it.origen === "web" ? "de la web" : "a mano"}</span>
              <button className="icon-btn" title="Quitar" onClick={() => onChange(items.filter((_, j) => j !== i))}>×</button>
            </span>
          </div>
          {alertas && alertas[it.nombre] && (
            <div className="shared-alert">⚠ Este repuesto también aplica a: {alertas[it.nombre].join(", ")} — podés unificar el pedido.</div>
          )}
        </div>
      ))}
      <InlineAdd placeholder={placeholder} onAdd={(nombre) => onChange([...items, { nombre, origen: "manual" }])} />
    </div>
  );
}

function BotonExtraer({ equipo, onUpdate }) {
  const [estado, setEstado] = useState("");
  const base = (equipo.manuales || []).find((m) => (m.driveId || m.url) && m.tipo === "despiece") || (equipo.manuales || []).find((m) => (m.driveId || m.url) && m.tipo === "tecnico") || (equipo.manuales || []).find((m) => m.driveId || m.url);
  if (!base) return null;
  const run = async () => {
    setEstado("Leyendo " + base.titulo + "…");
    try {
      const x = await api("extraer", { driveId: base.driveId, url: base.url, titulo: base.titulo, equipo: equipo.nombre });
      onUpdate({
        insumos: unirItems(equipo.insumos, x.insumos.map((i) => ({ ...i, origen: "auto" }))),
        repuestos: unirItems(equipo.repuestos, x.repuestos.map((r) => ({ ...r, origen: "auto" }))),
      });
      setEstado(`✓ ${x.insumos.length} insumos y ${x.repuestos.length} repuestos leídos del manual`);
    } catch (e) {
      setEstado("✕ " + e.message);
    }
  };
  return (
    <div className="row gap wrap mb">
      <button className="btn small" onClick={run}>Releer del manual</button>
      {estado && <span className="small muted">{estado}</span>}
    </div>
  );
}

const ORIGEN_FALLA = { manual: "del manual", web: "de la web", propia: "registro propio" };

function FotoInput({ onFoto, disabled, label = "📷 Foto" }) {
  const ref = useRef(null);
  return (
    <label className={"btn" + (disabled ? " disabled" : "")}>
      {label}
      <input
        ref={ref}
        type="file"
        accept="image/*"
        capture="environment"
        hidden
        disabled={disabled}
        onChange={(e) => {
          const f = e.target.files[0];
          if (f) onFoto(f);
          ref.current.value = "";
        }}
      />
    </label>
  );
}

// Sube una foto reducida a Drive y devuelve {thumb, driveId, driveLink}.
// Si Drive no esta conectado se queda solo con la miniatura.
async function procesarFoto(file, nombre) {
  const [grande, mini] = await Promise.all([reducirImagen(file, 1600, 0.8), reducirImagen(file, 240, 0.6)]);
  try {
    const d = await subirADrive(grande.blob, nombreSeguro(nombre) + ".jpg");
    return { thumb: mini.dataUrl, ...d };
  } catch (e) {
    return { thumb: mini.dataUrl, aviso: "solo miniatura (Drive: " + e.message + ")" };
  }
}

function TabFallas({ equipo, onUpdate }) {
  const fallas = equipo.fallas || [];
  const [estado, setEstado] = useState("");
  const [ocupado, setOcupado] = useState(false);
  const [filtro, setFiltro] = useState("");
  const [nueva, setNueva] = useState({ falla: "", solucion: "" });
  const [foto, setFoto] = useState(null);
  const [abierta, setAbierta] = useState(null);

  const base = (equipo.manuales || []).find((m) => (m.driveId || m.url) && m.tipo === "tecnico") || (equipo.manuales || []).find((m) => m.driveId || m.url);

  const buscar = async () => {
    setOcupado(true);
    setEstado(base ? "Leyendo el manual y buscando en foros…" : "Buscando en foros y la web…");
    try {
      const r = await api("fallas", { equipo: { nombre: equipo.nombre, marca: equipo.marca, modelo: equipo.modelo }, driveId: base && base.driveId, url: base && base.url, titulo: base && base.titulo });
      const existentes = new Set(fallas.map((f) => f.falla.toLowerCase().trim()));
      const nuevas = r.fallas.filter((f) => !existentes.has(f.falla.toLowerCase().trim())).map((f) => ({ ...f, id: "f" + Date.now() + Math.random().toString(36).slice(2, 6), notas: [] }));
      onUpdate({ fallas: [...fallas, ...nuevas], fuentesFallas: r.fuentes });
      setEstado(`✓ ${nuevas.length} fallas nuevas` + (r.avisos.length ? " · " + r.avisos.join(" · ") : ""));
    } catch (e) {
      setEstado("✕ " + e.message);
    }
    setOcupado(false);
  };

  const agregar = async () => {
    if (!nueva.falla.trim()) return setEstado("Escribí la falla o el síntoma");
    setOcupado(true);
    let f = { id: "f" + Date.now(), falla: nueva.falla.trim(), causas: "", solucion: nueva.solucion.trim(), origen: "propia", fecha: new Date().toISOString(), notas: [] };
    if (foto) {
      setEstado("Subiendo foto…");
      f.foto = await procesarFoto(foto, `${equipo.nombre} - falla - ${f.falla.slice(0, 40)}`).catch(() => null);
    }
    onUpdate({ fallas: [f, ...fallas] });
    setNueva({ falla: "", solucion: "" });
    setFoto(null);
    setEstado("✓ Falla guardada");
    setOcupado(false);
  };

  const cambiar = (id, patch) => onUpdate({ fallas: fallas.map((f) => (f.id === id ? { ...f, ...patch } : f)) });

  const t = filtro.trim().toLowerCase();
  const lista = t ? fallas.filter((f) => [f.falla, f.causas, f.solucion, ...(f.notas || []).map((n) => n.texto)].join(" ").toLowerCase().includes(t)) : fallas;

  return (
    <div>
      <div className="panel-sub mt0">
        <div className="section-title"><h4>Registrar falla y reparación</h4></div>
        <input className="field" placeholder="Falla / síntoma / código de error (ej: Err 12 NIBP)" value={nueva.falla} onChange={(e) => setNueva({ ...nueva, falla: e.target.value })} />
        <textarea className="field" rows="3" placeholder="Cómo se reparó (opcional)" value={nueva.solucion} onChange={(e) => setNueva({ ...nueva, solucion: e.target.value })} />
        <div className="row gap wrap mt">
          <FotoInput label={foto ? "📷 Foto lista ✓" : "📷 Agregar foto"} onFoto={setFoto} disabled={ocupado} />
          <button className="btn primary" onClick={agregar} disabled={ocupado}>Guardar falla</button>
        </div>
      </div>

      <div className="row gap wrap mt">
        <button className="btn" onClick={buscar} disabled={ocupado}>{fallas.length ? "Buscar más fallas comunes" : "Buscar fallas comunes"}</button>
        {fallas.length > 4 && <input className="field grow mt0" placeholder="Filtrar fallas…" value={filtro} onChange={(e) => setFiltro(e.target.value)} />}
      </div>
      {estado && <div className="small estado">{ocupado && <span className="spinner" />} {estado}</div>}

      {fallas.length === 0 && !ocupado && <p className="muted">Todavía no hay fallas. Buscalas automáticamente (del manual y de foros) o registrá las tuyas.</p>}
      <div className="mt">
        {lista.map((f) => (
          <div className="falla" key={f.id}>
            <button className="falla-head" onClick={() => setAbierta(abierta === f.id ? null : f.id)}>
              <span className="grow">{f.falla}</span>
              <span className={"tag " + (f.origen === "propia" ? "tag-ok" : "")}>{ORIGEN_FALLA[f.origen] || f.origen}{f.pagina ? " · pág. " + f.pagina : ""}{(f.ias || []).length ? " · " + nombresIA(f.ias) : ""}</span>
              {(f.notas || []).length > 0 && <span className="tag tag-ok">+{f.notas.length}</span>}
            </button>
            {abierta === f.id && (
              <div className="falla-body">
                {f.foto && f.foto.thumb && (
                  <a href={f.foto.driveLink || f.foto.thumb} target="_blank" rel="noreferrer"><img className="foto-mini" src={f.foto.thumb} alt="" /></a>
                )}
                {f.causas && <p><b>Causas:</b> {f.causas}</p>}
                {f.solucion && <p className="pre"><b>Reparación:</b> {f.solucion}</p>}
                {(f.notas || []).map((n, i) => (
                  <div className="nota" key={i}>
                    <div className="small muted">{new Date(n.fecha).toLocaleDateString()} · reparación registrada</div>
                    <div className="pre">{n.texto}</div>
                    {n.foto && n.foto.thumb && (
                      <a href={n.foto.driveLink || n.foto.thumb} target="_blank" rel="noreferrer"><img className="foto-mini" src={n.foto.thumb} alt="" /></a>
                    )}
                  </div>
                ))}
                <InlineAdd
                  placeholder="Agregar otra forma de reparación / nota…"
                  onAdd={(texto) => cambiar(f.id, { notas: [...(f.notas || []), { texto, fecha: new Date().toISOString() }] })}
                />
                <div className="row gap mt">
                  <FotoInput
                    label="📷 Foto a esta falla"
                    onFoto={async (file) => {
                      setEstado("Subiendo foto…");
                      const foto = await procesarFoto(file, `${equipo.nombre} - falla - ${f.falla.slice(0, 40)}`).catch(() => null);
                      if (foto) cambiar(f.id, { notas: [...(f.notas || []), { texto: "Foto", fecha: new Date().toISOString(), foto }] });
                      setEstado(foto ? "✓ Foto agregada" + (foto.aviso ? " (" + foto.aviso + ")" : "") : "✕ No se pudo procesar la foto");
                    }}
                  />
                  <button className="btn small danger-outline" onClick={() => confirm("¿Borrar esta falla?") && onUpdate({ fallas: fallas.filter((x) => x.id !== f.id) })}>Borrar</button>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
      {(equipo.fuentesFallas || []).length > 0 && (
        <div className="small muted mt">
          Fuentes web: {equipo.fuentesFallas.map((s, i) => <span key={i}>{i > 0 && ", "}<a href={s.url} target="_blank" rel="noreferrer">{s.titulo}</a></span>)}
        </div>
      )}
    </div>
  );
}

function TabArchivos({ equipo, onUpdate }) {
  const archivos = equipo.archivos || [];
  const [desc, setDesc] = useState("");
  const [estado, setEstado] = useState("");
  const [ocupado, setOcupado] = useState(false);
  const fileRef = useRef(null);

  const guardar = (a) => onUpdate({ archivos: [{ ...a, descripcion: desc.trim(), fecha: new Date().toISOString() }, ...archivos] });

  const subirFoto = async (file) => {
    setOcupado(true);
    setEstado("Subiendo foto…");
    try {
      const f = await procesarFoto(file, `${equipo.nombre} - foto - ${desc || Date.now()}`);
      guardar({ tipo: "foto", nombre: desc || "Foto", ...f });
      setDesc("");
      setEstado(f.aviso ? "⚠ " + f.aviso : "✓ Foto guardada en Drive");
    } catch (e) {
      setEstado("✕ " + e.message);
    }
    setOcupado(false);
  };

  const subirArchivo = async (file) => {
    if (!file) return;
    if (file.type.startsWith("image/")) return subirFoto(file);
    setOcupado(true);
    setEstado("Subiendo " + file.name + "…");
    try {
      const d = await subirADrive(file, nombreSeguro(`${equipo.nombre} - ${file.name}`));
      guardar({ tipo: "archivo", nombre: file.name, mime: file.type, tamano: file.size, ...d });
      setDesc("");
      setEstado("✓ Guardado en Drive" + (file.type === "application/pdf" ? " · también se usa en las Consultas" : ""));
    } catch (e) {
      setEstado("✕ " + e.message);
    }
    setOcupado(false);
    if (fileRef.current) fileRef.current.value = "";
  };

  const fotos = archivos.filter((a) => a.tipo === "foto");
  const otros = archivos.filter((a) => a.tipo !== "foto");
  const quitar = (a) => confirm("¿Quitar de la ficha? (si está en Drive, queda ahí)") && onUpdate({ archivos: archivos.filter((x) => x !== a) });

  return (
    <div>
      <div className="panel-sub mt0">
        <div className="section-title"><h4>Subir foto o archivo</h4></div>
        <p className="small muted">Fotos de placas, etiquetas, fallas, boletines, planillas, PDFs que no están en la app… Todo queda en la carpeta de Drive del equipo.</p>
        <input className="field" placeholder="Descripción (opcional): ej. placa principal, etiqueta de serie…" value={desc} onChange={(e) => setDesc(e.target.value)} />
        <div className="row gap wrap mt">
          <FotoInput label="📷 Sacar / subir foto" onFoto={subirFoto} disabled={ocupado} />
          <label className={"btn" + (ocupado ? " disabled" : "")}>
            📎 Subir archivo
            <input ref={fileRef} type="file" hidden disabled={ocupado} onChange={(e) => subirArchivo(e.target.files[0])} />
          </label>
        </div>
        {estado && <div className="small estado">{ocupado && <span className="spinner" />} {estado}</div>}
      </div>

      {archivos.length === 0 && <p className="muted mt">Todavía no hay fotos ni archivos.</p>}
      {fotos.length > 0 && (
        <div className="foto-grid mt">
          {fotos.map((a, i) => (
            <div className="foto-card" key={i}>
              <a href={a.driveLink || a.thumb} target="_blank" rel="noreferrer"><img src={a.thumb} alt={a.nombre} /></a>
              <div className="row">
                <span className="small grow">{a.descripcion || a.nombre}</span>
                <button className="icon-btn" title="Quitar" onClick={() => quitar(a)}>×</button>
              </div>
            </div>
          ))}
        </div>
      )}
      <div className="mt">
        {otros.map((a, i) => (
          <div className="link-item" key={i}>
            <div className="grow">
              <a href={a.driveLink} target="_blank" rel="noreferrer">{a.nombre}</a>
              <div className="small muted">{a.descripcion}{a.tamano ? " · " + (a.tamano / 1048576).toFixed(1) + " MB" : ""}</div>
            </div>
            <button className="icon-btn" title="Quitar" onClick={() => quitar(a)}>×</button>
          </div>
        ))}
      </div>
    </div>
  );
}

function TabConsulta({ equipo, iasActivas = [], onUpdate }) {
  const enDrive = (equipo.manuales || []).filter((m) => m.driveId || m.url).length;
  const [mensajes, setMensajes] = useState([
    {
      rol: "bot",
      texto: enDrive
        ? `Preguntame lo que necesites del ${equipo.nombre}. Respondo leyendo sus ${enDrive} manual(es) y te cito la página.`
        : `Todavía no hay manuales para el ${equipo.nombre}; voy a responder buscando en la web. Cargá el manual en la pestaña Manuales para respuestas exactas.`,
      fuentes: [],
    },
  ]);
  const [input, setInput] = useState("");
  const [cargando, setCargando] = useState(false);
  const [comparar, setComparar] = useState(() => leerLS("msem.comparar", false));
  const scrollRef = useRef(null);
  const puedeComparar = iasActivas.length > 1;

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [mensajes, cargando]);

  const enviar = async () => {
    const pregunta = input.trim();
    if (!pregunta || cargando) return;
    setInput("");
    const historial = mensajes.slice(1);
    setMensajes((prev) => [...prev, { rol: "user", texto: pregunta }]);
    setCargando(true);
    try {
      const r = await api("consultar", {
        equipo: {
          nombre: equipo.nombre,
          marca: equipo.marca,
          modelo: equipo.modelo,
          manuales: [
            ...(equipo.manuales || []),
            ...(equipo.archivos || []).filter((a) => a.driveId && a.mime === "application/pdf").map((a) => ({ tipo: "otro", titulo: a.descripcion || a.nombre, driveId: a.driveId, driveLink: a.driveLink })),
          ],
          fallas: (equipo.fallas || []).map((f) => ({ falla: f.falla, solucion: f.solucion, origen: f.origen, notas: (f.notas || []).filter((n) => n.texto !== "Foto").map((n) => ({ texto: n.texto })) })),
        },
        pregunta,
        historial: historial.map((m) => ({ rol: m.rol, texto: m.texto })),
        comparar: comparar && puedeComparar,
      });
      setMensajes((prev) => [...prev, { rol: "bot", texto: r.respuesta, fuentes: r.fuentes || [], modo: r.modo, ia: r.ia, comparacion: r.comparacion }]);
      if (r.comparacion && r.comparacion.mejor) {
        const g = { ...(equipo.consultasGanadas || {}) };
        g[r.comparacion.mejor] = (g[r.comparacion.mejor] || 0) + 1;
        onUpdate({ consultasGanadas: g });
      }
    } catch (e) {
      setMensajes((prev) => [...prev, { rol: "bot", texto: "✕ " + e.message, fuentes: [] }]);
    }
    setCargando(false);
  };

  return (
    <div className="chat-box">
      <div className="chat-messages" ref={scrollRef}>
        {mensajes.map((m, i) => (
          <div key={i} className={`msg ${m.rol === "user" ? "user" : "bot"}`}>
            {m.comparacion ? (
              <div className="ia-ganadora">🏆 Mejor respuesta: {IAS[m.comparacion.mejor]}{m.comparacion.motivo && <span className="muted"> — {m.comparacion.motivo}</span>}</div>
            ) : m.ia && puedeComparar ? (
              <div className="small muted">{IAS[m.ia]}</div>
            ) : null}
            {m.texto}
            {m.fuentes && m.fuentes.length > 0 && (
              <div className="sources">
                {m.modo === "web" ? "Fuentes web: " : "Manuales: "}
                {m.fuentes.map((f, j) => (
                  <span key={j}>
                    <a href={f.url} target="_blank" rel="noreferrer">{f.titulo || f.url}</a>
                    {j < m.fuentes.length - 1 ? ", " : ""}
                  </span>
                ))}
              </div>
            )}
            {m.comparacion && m.comparacion.respuestas.filter((x) => x.ia !== m.comparacion.mejor).map((x) => (
              <details className="otra-ia" key={x.ia}>
                <summary>{IAS[x.ia]} {x.ok ? "" : "✕ no respondió"}</summary>
                <div className="pre">{x.ok ? x.text : x.error}</div>
              </details>
            ))}
          </div>
        ))}
        {cargando && <div className="msg bot"><span className="spinner" /> {comparar && puedeComparar ? "Consultando " + iasActivas.map((i) => IAS[i]).join(", ") + "…" : "Leyendo el manual…"}</div>}
      </div>
      {puedeComparar && (
        <label className="comparar">
          <input type="checkbox" checked={comparar} onChange={(e) => { setComparar(e.target.checked); guardarLS("msem.comparar", e.target.checked); }} />
          Comparar IAs ({iasActivas.map((i) => IAS[i]).join(", ")}) y quedarme con la mejor
        </label>
      )}
      <div className="chat-input">
        <input placeholder="Ej: ¿Cómo se calibra el módulo de NIBP?" value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => e.key === "Enter" && enviar()} />
        <button className="btn primary" onClick={enviar} disabled={cargando}>Enviar</button>
      </div>
    </div>
  );
}

function FichaEquipo({ equipo, todosLosEquipos, onVolver, onUpdate, onBorrar, iasActivas }) {
  const [tab, setTab] = useState("consulta");
  const alertas = useMemo(() => detectarRepuestosCompartidos(equipo, todosLosEquipos), [equipo, todosLosEquipos]);
  const tabs = [
    { id: "consulta", label: "Consulta" },
    { id: "fallas", label: `Fallas (${(equipo.fallas || []).length})` },
    { id: "manuales", label: `Manuales (${(equipo.manuales || []).length})` },
    { id: "videos", label: `Videos (${(equipo.videos || []).length})` },
    { id: "archivos", label: `Fotos y archivos (${(equipo.archivos || []).length})` },
    { id: "insumos", label: "Insumos" },
    { id: "repuestos", label: "Repuestos" },
  ];

  return (
    <div>
      <button className="back-btn" onClick={onVolver}>← Volver a la biblioteca</button>
      <div className="equipo-title">
        <div>
          <h2>{equipo.nombre}</h2>
          <span className="marca-modelo">{[equipo.tipoEquipo, equipo.marca, equipo.modelo].filter(Boolean).join(" · ")}</span>
        </div>
        <button className="btn small danger-outline" onClick={() => confirm(`¿Eliminar "${equipo.nombre}" de la biblioteca? Los PDFs quedan en Drive.`) && onBorrar()}>Eliminar</button>
      </div>
      <div className="tabs">
        {tabs.map((t) => (
          <button key={t.id} className={`tab ${tab === t.id ? "active" : ""}`} onClick={() => setTab(t.id)}>{t.label}</button>
        ))}
      </div>
      {tab === "consulta" && <TabConsulta key={equipo.id} equipo={equipo} iasActivas={iasActivas} onUpdate={onUpdate} />}
      {tab === "fallas" && <TabFallas equipo={equipo} onUpdate={onUpdate} />}
      {tab === "archivos" && <TabArchivos equipo={equipo} onUpdate={onUpdate} />}
      {tab === "manuales" && <TabManuales equipo={equipo} onUpdate={onUpdate} />}
      {tab === "videos" && <TabVideos equipo={equipo} onUpdate={onUpdate} />}
      {tab === "insumos" && (
        <div>
          <BotonExtraer equipo={equipo} onUpdate={onUpdate} />
          <ListaItems items={equipo.insumos || []} onChange={(insumos) => onUpdate({ insumos })} placeholder="Agregar insumo que no se detectó..." />
        </div>
      )}
      {tab === "repuestos" && (
        <div>
          <BotonExtraer equipo={equipo} onUpdate={onUpdate} />
          <ListaItems items={equipo.repuestos || []} alertas={alertas} onChange={(repuestos) => onUpdate({ repuestos })} placeholder="Agregar repuesto que no se detectó..." />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// CONFIGURACION (con PIN de confirmacion)
// ---------------------------------------------------------------------------
function PinGate({ onOk, onClose }) {
  const [pin, setPin] = useState("");
  const [pin2, setPin2] = useState("");
  const [err, setErr] = useState("");
  const [modo, setModo] = useState("cargando"); // servidor | local | crear
  useEffect(() => {
    api("estado")
      .then((s) => setModo(s.pinServidor ? "servidor" : leerLS(LS_PIN, null) ? "local" : "crear"))
      .catch(() => setModo(leerLS(LS_PIN, null) ? "local" : "crear"));
  }, []);

  const confirmar = async () => {
    setErr("");
    if (modo === "servidor") {
      const r = await api("estado", { pin }).catch(() => ({ ok: false }));
      return r.ok ? onOk() : setErr("PIN incorrecto");
    }
    if (modo === "crear") {
      if (pin.length < 4) return setErr("El PIN debe tener al menos 4 dígitos");
      if (pin !== pin2) return setErr("Los PIN no coinciden");
      guardarLS(LS_PIN, await sha256(pin));
      return onOk();
    }
    return (await sha256(pin)) === leerLS(LS_PIN, "") ? onOk() : setErr("PIN incorrecto");
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal narrow" onClick={(e) => e.stopPropagation()}>
        <button className="close" onClick={onClose} aria-label="Cerrar">×</button>
        <h2>Acceso a Configuración</h2>
        {modo === "cargando" && <p className="muted"><span className="spinner" /> Verificando…</p>}
        {modo === "crear" && <p className="small muted">Primera vez: creá un PIN para proteger la configuración en este dispositivo.</p>}
        {modo !== "cargando" && (
          <form onSubmit={(e) => { e.preventDefault(); confirmar(); }}>
            <input className="field" type="password" inputMode="numeric" autoFocus placeholder="PIN" value={pin} onChange={(e) => setPin(e.target.value)} />
            {modo === "crear" && <input className="field" type="password" inputMode="numeric" placeholder="Repetir PIN" value={pin2} onChange={(e) => setPin2(e.target.value)} />}
            {err && <div className="alert">{err}</div>}
            <div className="row-end"><button className="btn primary" type="submit">Confirmar</button></div>
          </form>
        )}
      </div>
    </div>
  );
}

function Estado({ ok, label, detalle }) {
  return (
    <div className="estado-row">
      <span className={ok ? "check" : "fail"}>{ok ? "✓" : "✕"}</span>
      <div>
        <div>{label}</div>
        {detalle && <div className="small muted">{detalle}</div>}
      </div>
    </div>
  );
}

function Copiar({ texto }) {
  const [ok, setOk] = useState(false);
  return (
    <span className="copiar">
      <code>{texto}</code>
      <button
        className="btn small"
        onClick={() => {
          navigator.clipboard && navigator.clipboard.writeText(texto).then(() => {
            setOk(true);
            setTimeout(() => setOk(false), 1500);
          });
        }}
      >
        {ok ? "✓" : "Copiar"}
      </button>
    </span>
  );
}

const L = ({ href, children }) => <a href={href} target="_blank" rel="noreferrer">{children} ↗</a>;

function GuiaApis({ estado }) {
  const redirect = location.origin + "/api/drive-auth";
  const e = estado && !estado.error ? estado : {};
  const Paso = ({ ok, titulo, children }) => (
    <details className="paso" open={!ok}>
      <summary><span className={ok ? "check" : "fail"}>{ok ? "✓" : "•"}</span> {titulo}</summary>
      <div className="paso-body">{children}</div>
    </details>
  );
  return (
    <div className="panel-sub">
      <div className="section-title"><h4>Guía rápida: conseguir las claves</h4></div>
      <p className="small muted">Cada clave va en Vercel → <L href="https://vercel.com/dashboard">tu proyecto</L> → Settings → Environment Variables. Después: Deployments → ⋯ → Redeploy.</p>

      <Paso ok={e.gemini} titulo="1. Gemini (obligatoria, gratis)">
        <ol>
          <li>Entrá a <L href="https://aistudio.google.com/apikey">Google AI Studio → API keys</L> y tocá “Create API key”.</li>
          <li>Copiala a Vercel como <code>GEMINI_API_KEY</code> (o pegala abajo para probar ya).</li>
          <li><b>Importante para que encuentre manuales:</b> la clave sirve para preguntas, pero la búsqueda en Google (necesaria para encontrar los PDF) no tiene cupo gratis. Andá a <L href="https://console.cloud.google.com/billing/linkedaccount">Facturación de Google Cloud</L> y vinculá una tarjeta al proyecto de tu clave — el uso real de esta app cuesta centavos, no es una suscripción. Sin esto, "Buscar y agregar" no va a encontrar nada. Alternativa sin tarjeta: agregar Grok abajo (trae su propia búsqueda).</li>
        </ol>
      </Paso>

      <Paso ok={e.drive} titulo="2. Google Drive (para alojar manuales, fotos y la biblioteca)">
        <ol>
          <li>Creá un proyecto: <L href="https://console.cloud.google.com/projectcreate">Nuevo proyecto de Google Cloud</L>.</li>
          <li>Habilitá la API: <L href="https://console.cloud.google.com/apis/library/drive.googleapis.com">Google Drive API → Habilitar</L>.</li>
          <li>Pantalla de consentimiento: <L href="https://console.cloud.google.com/auth/overview">Google Auth Platform</L> → Comenzar → tipo <b>Externo</b>. Luego en <L href="https://console.cloud.google.com/auth/audience">Público</L> tocá <b>Publicar app</b> (si queda en prueba, vence a los 7 días).</li>
          <li>Credencial: <L href="https://console.cloud.google.com/auth/clients/create">Crear cliente OAuth</L> → tipo <b>Aplicación web</b> → en “URI de redireccionamiento autorizados” pegá: <Copiar texto={redirect} /></li>
          <li>Copiá el ID y el secreto a Vercel como <code>GOOGLE_CLIENT_ID</code> y <code>GOOGLE_CLIENT_SECRET</code> y redeployá.</li>
          <li>{e.driveCliente ? <a className="btn primary small" href="/api/drive-auth">Conectar Google Drive</a> : <b>Conectar Google Drive</b>} → aceptás → copiás el token que aparece a <code>GOOGLE_REFRESH_TOKEN</code> en Vercel y redeployás.</li>
        </ol>
      </Paso>

      <Paso ok={e.youtube} titulo="3. YouTube (opcional, mejores videos)">
        <ol>
          <li>En el mismo proyecto: <L href="https://console.cloud.google.com/apis/library/youtube.googleapis.com">YouTube Data API v3 → Habilitar</L>.</li>
          <li><L href="https://console.cloud.google.com/apis/credentials">Credenciales</L> → Crear credenciales → <b>Clave de API</b>.</li>
          <li>Copiala a Vercel como <code>YOUTUBE_API_KEY</code>.</li>
        </ol>
      </Paso>

      <Paso ok={e.grok} titulo="4. Grok (opcional, pago por uso)">
        <ol>
          <li>Creá la clave en <L href="https://console.x.ai/team/default/api-keys">consola de xAI → API keys</L> (necesita saldo cargado en Billing).</li>
          <li>Copiala a Vercel como <code>XAI_API_KEY</code> (o pegala abajo).</li>
        </ol>
      </Paso>

      <Paso ok={e.deepseek} titulo="5. DeepSeek (opcional, muy barato)">
        <ol>
          <li>Creá la clave en <L href="https://platform.deepseek.com/api_keys">DeepSeek Platform → API keys</L> y cargá unos dólares en <L href="https://platform.deepseek.com/top_up">Top up</L>.</li>
          <li>Copiala a Vercel como <code>DEEPSEEK_API_KEY</code> (o pegala abajo).</li>
        </ol>
      </Paso>

      <Paso ok={e.pinServidor} titulo="6. PIN común (recomendado)">
        <p className="small">Agregá en Vercel <code>ADMIN_PIN</code> con el PIN que quieras: así todos entran a Configuración con el mismo PIN.</p>
      </Paso>
    </div>
  );
}

function Ranking({ equipos }) {
  const t = rankingIAs(equipos);
  const filas = Object.entries(t).filter(([, v]) => v.sugeridos || v.validos || v.fallas || v.consultas);
  if (!filas.length) return null;
  const tasa = (v) => (v.sugeridos ? Math.round((100 * v.validos) / v.sugeridos) : 0);
  filas.sort((a, b) => b[1].validos - a[1].validos || tasa(b[1]) - tasa(a[1]));
  return (
    <div className="panel-sub">
      <div className="section-title"><h4>Ranking de IAs</h4></div>
      <p className="small muted">Qué IA encontró de verdad los manuales (PDF que se pudo descargar), sobre toda tu biblioteca.</p>
      <table className="ranking">
        <thead>
          <tr><th>IA</th><th>PDF válidos</th><th>Links</th><th>Acierto</th><th>Fallas</th><th>🏆 Consultas</th></tr>
        </thead>
        <tbody>
          {filas.map(([ia, v], i) => (
            <tr key={ia}>
              <td>{i === 0 ? "🥇 " : ""}{IAS[ia]}</td>
              <td>{v.validos}</td>
              <td>{v.sugeridos}</td>
              <td>{tasa(v)}%</td>
              <td>{v.fallas}</td>
              <td>{v.consultas}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ModalConfig({ onClose, onGuardado, equipos = [] }) {
  const [cfg, setCfg] = useState(() => leerLS(LS_CFG, {}));
  const [estado, setEstado] = useState(null);
  const [probando, setProbando] = useState(false);

  const probar = async () => {
    setProbando(true);
    try {
      setEstado(await api("estado?probar=1"));
    } catch (e) {
      setEstado({ error: e.message });
    }
    setProbando(false);
  };
  useEffect(() => {
    probar();
  }, []);

  const set = (k) => (e) => setCfg({ ...cfg, [k]: e.target.value.trim() });
  const guardar = async () => {
    guardarLS(LS_CFG, cfg);
    await probar();
    onGuardado();
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <button className="close" onClick={onClose} aria-label="Cerrar">×</button>
        <h2>Configuración de APIs</h2>

        <div className="panel-sub">
          <div className="section-title"><h4>Estado</h4><button className="btn small" onClick={probar} disabled={probando}>{probando ? "Probando…" : "Probar conexión"}</button></div>
          {estado && estado.error && <div className="alert">{estado.error}</div>}
          {estado && !estado.error && (
            <div>
              {[
                ["gemini", "Gemini (lee los PDF; obligatoria)", estado.geminiModel, "Clave gratis en aistudio.google.com/apikey"],
                ["grok", "Grok (opcional)", estado.grokModel, "Opcional: segunda opinión con búsqueda web propia"],
                ["deepseek", "DeepSeek (opcional)", estado.deepseekModel, "Opcional: tercera opinión, muy económica"],
              ].map(([k, label, modelo, falta]) => {
                const p = (estado.pruebas || {})[k];
                return (
                  <Estado
                    key={k}
                    ok={estado[k] && (!p || p.ok)}
                    label={`${label} · ${modelo}`}
                    detalle={!estado[k] ? falta : p && !p.ok ? "La clave no funciona: " + p.error : p ? "Probada ✓" : ""}
                  />
                );
              })}
              <Estado ok={estado.drive} label="Google Drive (donde se alojan los manuales)" detalle={estado.drive ? "Carpeta: Manuales SEM" : !estado.driveCliente ? "Faltan GOOGLE_CLIENT_ID y GOOGLE_CLIENT_SECRET en Vercel" : estado.driveError || "Falta conectar la cuenta"} />
              <Estado ok={estado.youtube} label="YouTube Data API (opcional)" detalle={!estado.youtube && "Sin esta clave se usan solo los videos que encuentra Gemini"} />
            </div>
          )}
          {estado && estado.driveCliente && !estado.drive && (
            <a className="btn primary mt" href="/api/drive-auth">Conectar Google Drive</a>
          )}
        </div>

        <Ranking equipos={equipos} />

        <GuiaApis estado={estado} />

        <div className="panel-sub">
          <div className="section-title"><h4>Claves en este navegador</h4></div>
          <p className="small muted">Opcional: lo ideal es cargarlas como variables de entorno en Vercel (quedan para todos). Lo que pongas acá se guarda solo en este dispositivo y tiene prioridad.</p>
          <label>Gemini API key<input className="field" type="password" value={cfg.geminiKey || ""} onChange={set("geminiKey")} placeholder="AIza…" /></label>
          <label>Modelo Gemini<input className="field" value={cfg.geminiModel || ""} onChange={set("geminiModel")} placeholder="gemini-flash-latest" /></label>
          <label>Grok (xAI) API key<input className="field" type="password" value={cfg.grokKey || ""} onChange={set("grokKey")} placeholder="xai-…" /></label>
          <label>DeepSeek API key<input className="field" type="password" value={cfg.deepseekKey || ""} onChange={set("deepseekKey")} placeholder="sk-…" /></label>
          <label>YouTube API key<input className="field" type="password" value={cfg.youtubeKey || ""} onChange={set("youtubeKey")} placeholder="AIza…" /></label>
          <label>Drive refresh token<input className="field" type="password" value={cfg.refreshToken || ""} onChange={set("refreshToken")} placeholder="se completa con “Conectar Google Drive”" /></label>
          <label>ID de carpeta de Drive (opcional)<input className="field" value={cfg.folderId || ""} onChange={set("folderId")} placeholder="por defecto crea “Manuales SEM”" /></label>
          <div className="row-end gap">
            <button className="btn" onClick={() => { setCfg({}); guardarLS(LS_CFG, {}); }}>Borrar</button>
            <button className="btn primary" onClick={guardar}>Guardar</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// INSTALAR APP (PWA)
// ---------------------------------------------------------------------------
function useInstalar() {
  const [evento, setEvento] = useState(null);
  const [instalada, setInstalada] = useState(() => window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true);
  useEffect(() => {
    const h = (e) => {
      e.preventDefault();
      setEvento(e);
    };
    window.addEventListener("beforeinstallprompt", h);
    window.addEventListener("appinstalled", () => setInstalada(true));
    return () => window.removeEventListener("beforeinstallprompt", h);
  }, []);
  const esIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const instalar = async () => {
    if (evento) {
      evento.prompt();
      await evento.userChoice;
      setEvento(null);
    } else if (esIOS) alert("En iPhone/iPad: tocá Compartir y luego “Agregar a pantalla de inicio”.");
    else alert("Abrí el menú del navegador (⋮) y elegí “Instalar app” o “Agregar a pantalla principal”.");
  };
  return { mostrar: !instalada, instalar };
}

// ---------------------------------------------------------------------------
// APP
// ---------------------------------------------------------------------------
function App() {
  const { equipos, enDrive, cargando, guardar, borrar, recargar } = useEquipos();
  const [busqueda, setBusqueda] = useState("");
  const [equipoAbierto, setEquipoAbierto] = useState(null);
  const [agregando, setAgregando] = useState(null);
  const [config, setConfig] = useState(null); // null | "pin" | "abierta"
  const inst = useInstalar();
  const [iasActivas, setIasActivas] = useState([]);
  const cargarEstado = () =>
    api("estado")
      .then((e) => setIasActivas(Object.keys(IAS).filter((k) => e[k])))
      .catch(() => setIasActivas([]));
  useEffect(() => {
    cargarEstado();
  }, []);

  const term = busqueda.trim().toLowerCase();

  // Buscador completo: nombre, marca, modelo, manuales, insumos, repuestos.
  const resultados = useMemo(() => {
    if (!term) return equipos;
    return equipos.filter((e) => {
      const camposTexto = [
        e.nombre, e.marca, e.modelo, e.tipoEquipo,
        ...(e.manuales || []).map((m) => m.titulo),
        ...(e.insumos || []).map((i) => i.nombre + " " + (i.codigo || "")),
        ...(e.repuestos || []).map((r) => r.nombre + " " + (r.codigo || "")),
        ...(e.fallas || []).map((f) => f.falla),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return camposTexto.includes(term);
    });
  }, [equipos, term]);

  const existeExacto = equipos.some((e) => e.nombre.trim().toLowerCase() === term);
  const equipoActual = equipoAbierto ? equipos.find((e) => e.id === equipoAbierto) : null;

  const actualizar = (patch) => guardar({ ...equipoActual, ...patch });

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <img src="icon.svg" alt="" width="40" height="40" />
          <div>
            <h1>Manuales de Equipos</h1>
            <div className="sub">Biblioteca técnica, insumos y repuestos — SEM</div>
          </div>
        </div>
        <div className="row gap">
          {inst.mostrar && (
            <button className="btn" onClick={inst.instalar}><Icono d={IC.download} size={16} /> Instalar app</button>
          )}
          <button className="btn" onClick={() => setConfig("pin")} title="Configuración"><Icono d={IC.gear} size={16} /> Configuración</button>
        </div>
      </header>

      {!cargando && !enDrive && (
        <div className="banner">
          Drive no está conectado: la biblioteca se guarda solo en este dispositivo. <button className="linklike" onClick={() => setConfig("pin")}>Configurar</button>
        </div>
      )}

      {!equipoActual && (
        <React.Fragment>
          <form className="search-box" onSubmit={(e) => { e.preventDefault(); if (term && !existeExacto) setAgregando(busqueda.trim()); }}>
            <input placeholder="Buscar equipo, falla o repuesto — o escribí un equipo nuevo (ej: Mindray iPM 10)" value={busqueda} onChange={(e) => setBusqueda(e.target.value)} />
            <span className="icon"><Icono d={IC.search} /></span>
          </form>

          {term && !existeExacto && (
            <div className="add-row">
              <span>{resultados.length ? "¿No es ninguno de estos?" : `"${busqueda.trim()}" no está en la biblioteca.`}</span>
              <button className="btn primary" onClick={() => setAgregando(busqueda.trim())}>+ Buscar y agregar "{busqueda.trim()}"</button>
            </div>
          )}

          {cargando && equipos.length === 0 ? (
            <div className="empty-state"><span className="spinner" /> Cargando biblioteca…</div>
          ) : resultados.length === 0 ? (
            <div className="empty-state">
              {term ? "Sin resultados." : "La biblioteca está vacía. Escribí el nombre de un equipo arriba y tocá “Buscar y agregar”: la app busca sus manuales en internet, los guarda en Drive y después le podés hacer consultas."}
            </div>
          ) : (
            <div className="grid">
              {resultados.map((e) => {
                const enD = (e.manuales || []).filter((m) => m.driveId || m.url).length;
                return (
                  <button className="card" key={e.id} onClick={() => setEquipoAbierto(e.id)}>
                    <h3>{e.nombre}</h3>
                    <div className="meta">{[e.marca, e.modelo].filter(Boolean).join(" ") || e.tipoEquipo}</div>
                    <div className="badge-row">
                      <span className={`badge ${enD ? "ok" : "warn"}`}>{enD} manuales</span>
                      <span className="badge">{(e.fallas || []).length} fallas</span>
                      <span className="badge">{(e.videos || []).length} videos</span>
                      <span className="badge">{(e.insumos || []).length} insumos</span>
                      <span className="badge">{(e.repuestos || []).length} repuestos</span>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </React.Fragment>
      )}

      {equipoActual && (
        <FichaEquipo
          iasActivas={iasActivas}
          equipo={equipoActual}
          todosLosEquipos={equipos}
          onVolver={() => setEquipoAbierto(null)}
          onUpdate={actualizar}
          onBorrar={() => {
            borrar(equipoActual.id);
            setEquipoAbierto(null);
          }}
        />
      )}

      {agregando && (
        <ModalAgregarEquipo
          nombreInicial={agregando}
          onClose={() => setAgregando(null)}
          onCreado={async (equipo) => {
            await guardar(equipo);
            setAgregando(null);
            setBusqueda("");
            setEquipoAbierto(equipo.id);
          }}
        />
      )}

      {config === "pin" && <PinGate onOk={() => setConfig("abierta")} onClose={() => setConfig(null)} />}
      {config === "abierta" && <ModalConfig equipos={equipos} onClose={() => setConfig(null)} onGuardado={() => { recargar(); cargarEstado(); }} />}

      <footer className="note">
        {enDrive ? "✓ Biblioteca sincronizada con Google Drive" : "Biblioteca local"} · Las claves de las IA quedan del lado del servidor.
      </footer>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
}
