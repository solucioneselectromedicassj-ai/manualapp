const { useState, useEffect, useRef, useMemo } = React;

// ---------------------------------------------------------------------------
// CONFIG
// ---------------------------------------------------------------------------
// Firebase config va acá. Las claves de Firebase web son públicas por diseño
// (identifican el proyecto, no autorizan nada por sí solas) - la seguridad
// real la dan las reglas de Firestore. NO poner acá las API keys de Gemini/
// Grok/YouTube: esas quedan solo en las variables de entorno de Vercel y se
// usan desde /api/*.js (server-side).
const FIREBASE_CONFIG = {
  apiKey: "TODO",
  authDomain: "TODO.firebaseapp.com",
  projectId: "TODO",
  storageBucket: "TODO.appspot.com",
  messagingSenderId: "TODO",
  appId: "TODO",
};

let db = null;
try {
  if (FIREBASE_CONFIG.projectId !== "TODO") {
    firebase.initializeApp(FIREBASE_CONFIG);
    db = firebase.firestore();
  }
} catch (e) {
  console.warn("Firebase no configurado todavia:", e);
}

// ---------------------------------------------------------------------------
// DATOS DE EJEMPLO (se usan si Firestore no está configurado, para poder
// ver y probar la interfaz de entrada)
// ---------------------------------------------------------------------------
const MOCK_EQUIPOS = [
  {
    id: "mock-1",
    nombre: "Monitor Multiparamétrico",
    marca: "Mindray",
    modelo: "PM-9000",
    manuales: [
      { tipo: "usuario", titulo: "Manual de usuario PM-9000", url: "https://example.com/manual-usuario.pdf", fuente: "sitio oficial Mindray" },
      { tipo: "tecnico", titulo: "Manual técnico / service PM-9000", url: "https://example.com/manual-tecnico.pdf", fuente: "foro biomedica.org" },
      { tipo: "despiece", titulo: "Diagrama de despiece PM-9000", url: "https://example.com/despiece.pdf", fuente: "foro biomedica.org" },
    ],
    videos: [
      { titulo: "Calibración PM-9000 paso a paso", url: "https://youtube.com/watch?v=xxxx" },
      { titulo: "Reparación módulo SpO2 Mindray", url: "https://youtube.com/watch?v=yyyy" },
    ],
    insumos: [
      { nombre: "Sensor SpO2 adulto reusable", origen: "auto" },
      { nombre: "Cable ECG 5 derivaciones", origen: "auto" },
      { nombre: "Manguito NIBP adulto", origen: "manual" },
    ],
    repuestos: [
      { nombre: "Módulo NIBP", codigo: "115-018012-00", origen: "auto", compartidoCon: [] },
      { nombre: "Batería de litio 11.1V", codigo: "022-000044-00", origen: "auto", compartidoCon: ["Philips MP20", "Edan iM8"] },
    ],
    imagenes: [],
  },
];

// ---------------------------------------------------------------------------
// LLAMADAS A LA API (funciones serverless en /api)
// ---------------------------------------------------------------------------
async function apiAgregarEquipo(nombre, onProgress) {
  // El backend real hace streaming de progreso; acá hacemos fetch simple y
  // simulamos progreso si no hay conexión real. Ver api/agregar-equipo.js
  try {
    const res = await fetch("/api/agregar-equipo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nombre }),
    });
    if (!res.ok) throw new Error("Fallo la busqueda automatica");
    return await res.json();
  } catch (e) {
    // Fallback local para poder probar la UI sin backend desplegado todavia
    console.warn("API no disponible, usando resultado simulado:", e.message);
    await new Promise((r) => setTimeout(r, 1200));
    return {
      id: "eq-" + Date.now(),
      nombre,
      marca: "",
      modelo: "",
      manuales: [],
      videos: [],
      insumos: [],
      repuestos: [],
      imagenes: [],
    };
  }
}

async function apiConsultar(equipoId, pregunta) {
  try {
    const res = await fetch("/api/consultar", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ equipoId, pregunta }),
    });
    if (!res.ok) throw new Error("fallo consulta");
    return await res.json();
  } catch (e) {
    return {
      respuesta:
        "No pude conectar con el servicio de consulta todavia (falta desplegar /api/consultar con la clave de Gemini). " +
        "Cuando esté configurado, esta respuesta va a venir del manual del equipo con su cita de origen.",
      fuentes: [],
    };
  }
}

// ---------------------------------------------------------------------------
// FIRESTORE HELPERS (se usan solo si db esta configurado)
// ---------------------------------------------------------------------------
function useEquipos() {
  const [equipos, setEquipos] = useState(MOCK_EQUIPOS);
  const [loading, setLoading] = useState(!!db);

  useEffect(() => {
    if (!db) return;
    const unsub = db.collection("equipos").onSnapshot((snap) => {
      const list = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      setEquipos(list);
      setLoading(false);
    });
    return unsub;
  }, []);

  const addEquipo = async (equipo) => {
    if (db) {
      const ref = await db.collection("equipos").add(equipo);
      return { id: ref.id, ...equipo };
    }
    setEquipos((prev) => [...prev, equipo]);
    return equipo;
  };

  const updateEquipo = async (id, patch) => {
    if (db) {
      await db.collection("equipos").doc(id).update(patch);
    }
    setEquipos((prev) => prev.map((e) => (e.id === id ? { ...e, ...patch } : e)));
  };

  return { equipos, loading, addEquipo, updateEquipo };
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

// ---------------------------------------------------------------------------
// COMPONENTES
// ---------------------------------------------------------------------------

function ModalAgregarEquipo({ nombreInicial, onClose, onCreado }) {
  const [pasos, setPasos] = useState([
    { label: "Buscando manual de usuario", estado: "pendiente" },
    { label: "Buscando manual técnico", estado: "pendiente" },
    { label: "Buscando manual de despiece", estado: "pendiente" },
    { label: "Buscando videos en YouTube", estado: "pendiente" },
    { label: "Buscando referencias en foros", estado: "pendiente" },
    { label: "Guardando en Drive", estado: "pendiente" },
    { label: "Extrayendo insumos y repuestos del manual", estado: "pendiente" },
  ]);
  const [terminado, setTerminado] = useState(false);

  useEffect(() => {
    let cancel = false;
    async function run() {
      // Progreso visual mientras corre la busqueda real en el backend.
      for (let i = 0; i < pasos.length - 1; i++) {
        if (cancel) return;
        await new Promise((r) => setTimeout(r, 450));
        setPasos((prev) => prev.map((p, idx) => (idx === i ? { ...p, estado: "ok" } : p)));
      }
      const equipo = await apiAgregarEquipo(nombreInicial);
      if (cancel) return;
      setPasos((prev) => prev.map((p, idx) => (idx === prev.length - 1 ? { ...p, estado: "ok" } : p)));
      setTerminado(true);
      setTimeout(() => {
        if (!cancel) onCreado(equipo);
      }, 500);
    }
    run();
    return () => {
      cancel = true;
    };
  }, []);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <button className="close" onClick={onClose}>×</button>
        <h2>Agregando "{nombreInicial}"</h2>
        <p style={{ color: "var(--muted)", fontSize: "0.85rem" }}>
          Esto se hace una sola vez por equipo. Después vas a poder completar o corregir lo que falte.
        </p>
        <ul className="progress-list">
          {pasos.map((p, i) => (
            <li key={i}>
              {p.estado === "pendiente" && <span className="spinner" />}
              {p.estado === "ok" && <span className="check">✓</span>}
              {p.estado === "error" && <span className="fail">✕</span>}
              <span>{p.label}</span>
            </li>
          ))}
        </ul>
        {terminado && <p style={{ color: "var(--accent-2)" }}>Listo. Abriendo ficha del equipo…</p>}
      </div>
    </div>
  );
}

function InlineAdd({ placeholder, onAdd }) {
  const [val, setVal] = useState("");
  return (
    <div className="inline-add">
      <input
        placeholder={placeholder}
        value={val}
        onChange={(e) => setVal(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && val.trim()) {
            onAdd(val.trim());
            setVal("");
          }
        }}
      />
      <button
        onClick={() => {
          if (val.trim()) {
            onAdd(val.trim());
            setVal("");
          }
        }}
      >
        Agregar
      </button>
    </div>
  );
}

function TabManuales({ equipo }) {
  const tipos = { usuario: "Manual de usuario", tecnico: "Manual técnico", despiece: "Manual de despiece" };
  return (
    <div>
      {(equipo.manuales || []).length === 0 && (
        <p style={{ color: "var(--muted)" }}>Todavía no hay manuales cargados para este equipo.</p>
      )}
      {(equipo.manuales || []).map((m, i) => (
        <div className="link-item" key={i}>
          <div>
            <a href={m.url} target="_blank" rel="noreferrer">{m.titulo || tipos[m.tipo] || "Manual"}</a>
            {m.fuente && <div className="tag">fuente: {m.fuente}</div>}
          </div>
          <span className="tag">{tipos[m.tipo] || m.tipo}</span>
        </div>
      ))}
    </div>
  );
}

function TabVideos({ equipo }) {
  return (
    <div>
      {(equipo.videos || []).length === 0 && (
        <p style={{ color: "var(--muted)" }}>Todavía no hay videos encontrados para este equipo.</p>
      )}
      {(equipo.videos || []).map((v, i) => (
        <div className="link-item" key={i}>
          <a href={v.url} target="_blank" rel="noreferrer">{v.titulo}</a>
          <span className="tag">YouTube</span>
        </div>
      ))}
    </div>
  );
}

function TabInsumos({ equipo, onUpdate }) {
  const insumos = equipo.insumos || [];
  return (
    <div>
      {insumos.length === 0 && <p style={{ color: "var(--muted)" }}>Sin insumos cargados todavía.</p>}
      {insumos.map((it, i) => (
        <div className="item-row" key={i}>
          <span>{it.nombre}</span>
          <span className="origen">{it.origen === "auto" ? "detectado del manual" : "agregado a mano"}</span>
        </div>
      ))}
      <InlineAdd
        placeholder="Agregar insumo que no se detectó..."
        onAdd={(nombre) => onUpdate({ insumos: [...insumos, { nombre, origen: "manual" }] })}
      />
    </div>
  );
}

function TabRepuestos({ equipo, todosLosEquipos, onUpdate }) {
  const repuestos = equipo.repuestos || [];
  const alertas = useMemo(() => detectarRepuestosCompartidos(equipo, todosLosEquipos), [equipo, todosLosEquipos]);
  return (
    <div>
      {repuestos.length === 0 && <p style={{ color: "var(--muted)" }}>Sin repuestos cargados todavía.</p>}
      {repuestos.map((it, i) => (
        <div key={i}>
          <div className="item-row">
            <span>
              {it.nombre} {it.codigo && <span className="tag">{it.codigo}</span>}
            </span>
            <span className="origen">{it.origen === "auto" ? "detectado del manual" : "agregado a mano"}</span>
          </div>
          {alertas[it.nombre] && (
            <div className="shared-alert">
              ⚠ Este repuesto también aplica a: {alertas[it.nombre].join(", ")} — podés unificar el pedido.
            </div>
          )}
        </div>
      ))}
      <InlineAdd
        placeholder="Agregar repuesto que no se detectó..."
        onAdd={(nombre) => onUpdate({ repuestos: [...repuestos, { nombre, origen: "manual", compartidoCon: [] }] })}
      />
    </div>
  );
}

function TabConsulta({ equipo }) {
  const [mensajes, setMensajes] = useState([
    { rol: "bot", texto: `Preguntame algo sobre el ${equipo.nombre}. Busco la respuesta en sus manuales.`, fuentes: [] },
  ]);
  const [input, setInput] = useState("");
  const [cargando, setCargando] = useState(false);
  const scrollRef = useRef(null);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [mensajes]);

  const enviar = async () => {
    const pregunta = input.trim();
    if (!pregunta) return;
    setInput("");
    setMensajes((prev) => [...prev, { rol: "user", texto: pregunta }]);
    setCargando(true);
    const r = await apiConsultar(equipo.id, pregunta);
    setCargando(false);
    setMensajes((prev) => [...prev, { rol: "bot", texto: r.respuesta, fuentes: r.fuentes || [] }]);
  };

  return (
    <div className="chat-box">
      <div className="chat-messages" ref={scrollRef}>
        {mensajes.map((m, i) => (
          <div key={i} className={`msg ${m.rol === "user" ? "user" : "bot"}`}>
            {m.texto}
            {m.fuentes && m.fuentes.length > 0 && (
              <div className="sources">
                Fuente: {m.fuentes.map((f, j) => (
                  <span key={j}>
                    <a href={f.url} target="_blank" rel="noreferrer">{f.titulo || f.url}</a>
                    {j < m.fuentes.length - 1 ? ", " : ""}
                  </span>
                ))}
              </div>
            )}
          </div>
        ))}
        {cargando && <div className="msg bot">Buscando en el manual…</div>}
      </div>
      <div className="chat-input">
        <input
          placeholder="Ej: ¿Cómo se calibra el sensor de SpO2?"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && enviar()}
        />
        <button onClick={enviar}>Enviar</button>
      </div>
    </div>
  );
}

function FichaEquipo({ equipo, todosLosEquipos, onVolver, onUpdate }) {
  const [tab, setTab] = useState("consulta");
  const tabs = [
    { id: "consulta", label: "Consulta" },
    { id: "manuales", label: "Manuales" },
    { id: "videos", label: "Videos" },
    { id: "insumos", label: "Insumos" },
    { id: "repuestos", label: "Repuestos" },
  ];

  return (
    <div>
      <button className="back-btn" onClick={onVolver}>← Volver a la biblioteca</button>
      <div className="equipo-title">
        <h2>{equipo.nombre}</h2>
        {(equipo.marca || equipo.modelo) && (
          <span className="marca-modelo">{equipo.marca} {equipo.modelo}</span>
        )}
      </div>
      {equipo.imagenes && equipo.imagenes.length > 0 && (
        <div className="images-strip">
          {equipo.imagenes.map((src, i) => (
            <img key={i} src={src} alt={equipo.nombre} />
          ))}
        </div>
      )}
      <div className="tabs">
        {tabs.map((t) => (
          <div key={t.id} className={`tab ${tab === t.id ? "active" : ""}`} onClick={() => setTab(t.id)}>
            {t.label}
          </div>
        ))}
      </div>
      {tab === "consulta" && <TabConsulta equipo={equipo} />}
      {tab === "manuales" && <TabManuales equipo={equipo} />}
      {tab === "videos" && <TabVideos equipo={equipo} />}
      {tab === "insumos" && <TabInsumos equipo={equipo} onUpdate={(patch) => onUpdate(equipo.id, patch)} />}
      {tab === "repuestos" && (
        <TabRepuestos equipo={equipo} todosLosEquipos={todosLosEquipos} onUpdate={(patch) => onUpdate(equipo.id, patch)} />
      )}
    </div>
  );
}

function App() {
  const { equipos, addEquipo, updateEquipo } = useEquipos();
  const [busqueda, setBusqueda] = useState("");
  const [equipoAbierto, setEquipoAbierto] = useState(null);
  const [agregando, setAgregando] = useState(null); // nombre en proceso de alta

  const term = busqueda.trim().toLowerCase();

  // Buscador completo: nombre, marca, modelo, manuales, insumos, repuestos.
  const resultados = useMemo(() => {
    if (!term) return equipos;
    return equipos.filter((e) => {
      const camposTexto = [
        e.nombre, e.marca, e.modelo,
        ...(e.manuales || []).map((m) => m.titulo),
        ...(e.insumos || []).map((i) => i.nombre),
        ...(e.repuestos || []).map((r) => r.nombre + " " + (r.codigo || "")),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return camposTexto.includes(term);
    });
  }, [equipos, term]);

  const existeExacto = equipos.some((e) => e.nombre.trim().toLowerCase() === term);

  const equipoActual = equipoAbierto ? equipos.find((e) => e.id === equipoAbierto) : null;

  return (
    <div className="app">
      <header className="topbar">
        <div>
          <h1>Manuales de Equipos</h1>
          <div className="sub">Biblioteca técnica, insumos y repuestos — SEM</div>
        </div>
      </header>

      {!equipoActual && (
        <React.Fragment>
          <div className="search-box">
            <input
              placeholder="Buscar equipo, manual, insumo o repuesto..."
              value={busqueda}
              onChange={(e) => setBusqueda(e.target.value)}
            />
            <span className="icon">⌕</span>
          </div>

          {term && !existeExacto && (
            <div className="add-row">
              <span>No encontramos "{busqueda}" en la biblioteca.</span>
              <button className="add-btn" onClick={() => setAgregando(busqueda.trim())}>
                + Agregar "{busqueda.trim()}"
              </button>
            </div>
          )}

          {resultados.length === 0 ? (
            <div className="empty-state">Sin resultados. Agregá el equipo con el botón de arriba.</div>
          ) : (
            <div className="grid">
              {resultados.map((e) => (
                <div className="card" key={e.id} onClick={() => setEquipoAbierto(e.id)}>
                  <h3>{e.nombre}</h3>
                  <div className="meta">{e.marca} {e.modelo}</div>
                  <div className="badge-row">
                    <span className={`badge ${(e.manuales || []).length ? "ok" : "warn"}`}>
                      {(e.manuales || []).length} manuales
                    </span>
                    <span className="badge">{(e.videos || []).length} videos</span>
                    <span className="badge">{(e.insumos || []).length} insumos</span>
                    <span className="badge">{(e.repuestos || []).length} repuestos</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </React.Fragment>
      )}

      {equipoActual && (
        <FichaEquipo
          equipo={equipoActual}
          todosLosEquipos={equipos}
          onVolver={() => setEquipoAbierto(null)}
          onUpdate={updateEquipo}
        />
      )}

      {agregando && (
        <ModalAgregarEquipo
          nombreInicial={agregando}
          onClose={() => setAgregando(null)}
          onCreado={async (equipo) => {
            const creado = await addEquipo(equipo);
            setAgregando(null);
            setBusqueda("");
            setEquipoAbierto(creado.id);
          }}
        />
      )}

      <footer className="note">
        Acceso abierto, sin login. Las claves de las IA quedan del lado del servidor.
      </footer>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
