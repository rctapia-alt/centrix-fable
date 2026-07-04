/* =========================================================================
   AR.JS — Modo de Realidad Aumentada BASADO EN MARCADOR (AR.js / THREEx)
   ---------------------------------------------------------------------
   Migración desde WebXR (hit-test, sin marcador) a AR.js clásico con
   marcador impreso "Hiro". Motivo del cambio: WebXR "immersive-ar" solo
   existe en Chrome/Edge para Android con ARCore — deja fuera iPhone/iPad
   por completo y cualquier Android sin Google Play Services for AR. AR.js
   funciona con getUserMedia (cámara) puro, así que corre en Safari de
   iOS, Chrome/Firefox/Samsung Internet de Android, sin depender de
   ARCore ni ARKit.

   Librería usada: THREEx (AR.js three.js build, vendorizada en
   libs/arjs-threex.js) — expone el espacio de nombres global THREEx con
   THREEx.ArToolkitSource, THREEx.ArToolkitContext y THREEx.ArMarkerControls.

   Estrategia de integración (se conserva del módulo anterior, es la clave
   para no duplicar 2000 líneas de motor 3D): en vez de reconstruir los
   modelos, este módulo REPARENTA de forma temporal el grupo Three.js del
   equipo activo (Scene3D.groups[equip]) desde la escena principal (oculta
   durante la sesión AR) hacia una escena AR propia, como hijo del ancla
   del marcador. Como son las MISMAS mallas, todo lo que ya anima
   main.js/scene3d.js (rotor girando, interfase migrando, trazador
   sedimentando, arranque de la bomba) se sigue viendo en AR sin escribir
   una sola línea de física nueva. Al salir de AR, el grupo se devuelve
   intacto a la escena principal.

   Este módulo es independiente y opcional: si el navegador/dispositivo no
   tiene cámara o getUserMedia, el botón de AR se oculta y el resto del
   simulador sigue funcionando exactamente igual que antes.
   ========================================================================= */

const AR = (() => {

  // -----------------------------------------------------------------------
  // Estado interno
  // -----------------------------------------------------------------------
  let renderer, scene, camera;
  let arToolkitSource = null;
  let arToolkitContext = null;
  let markerRoot = null;    // THREE.Group controlado por THREEx.ArMarkerControls (sigue al marcador Hiro)
  let placedRoot = null;    // THREE.Group hijo de markerRoot — offset de usuario (rotar/escalar con gestos)
  let equipGroup = null;    // referencia al Scene3D.groups[equip] reparentado
  let equipOriginalTransform = null; // para restaurar posición/rotación al salir
  let equipParentOriginal = null;    // escena original a la que devolver el grupo
  let running = false;
  let rafId = null;

  // BUG REAL #1 (causa de "la cámara sale rotada y ampliada" + "los modelos
  // no salen al apuntar al Hiro"): THREEx.ArToolkitContext calibra su
  // detección de marcador (canvas interno + matriz de proyección) contra
  // el aspecto de pantalla que existía en el momento de crearse. Si el
  // estudiante rota el teléfono de portrait a landscape (o viceversa) con
  // la sesión de AR ya abierta, onResizeAR() reajusta el CSS del video y
  // del canvas al nuevo tamaño, pero NO reconstruye ese calibrado interno:
  // el resultado visible es exactamente el reportado (imagen/objeto
  // deformados como "girados y agrandados") y, como la correspondencia
  // 2D→3D del marcador quedó calculada contra el aspecto viejo, el
  // marcador deja de reconocerse de forma fiable y el equipo 3D no vuelve
  // a aparecer. Se detecta el cambio de orientación aquí y se reconstruye
  // el pipeline de detección (ver restartARForOrientationChange más abajo).
  let lastOrientationLandscape = null;
  let orientationRestartTimer = null;
  function isLandscapeNow() { return window.innerWidth > window.innerHeight; }

  let labelsOn = true;
  let theoryMode = false;
  let arParamsOpen = false; // panel de parámetros/transporte del overlay AR (móvil)

  // Debounce de aparición/desaparición del marcador — evita parpadeo si el
  // tracking pierde el marcador por un instante (mano delante, ángulo
  // extremo, motion blur). Se muestra de inmediato al detectarlo; se
  // oculta solo si estuvo perdido por más de MARKER_LOST_DELAY ms.
  const MARKER_LOST_DELAY = 350;
  let markerVisible = false;
  let markerLostTimer = null;

  // Gestos táctiles (rotar con 1 dedo, escalar con 2 dedos, tap para inspeccionar)
  const pointers = new Map();
  let gestureStartDist = null;
  let gestureStartScale = 1;
  let tapCandidate = null; // {x,y,moved}

  // -----------------------------------------------------------------------
  // Tamaño objetivo por equipo sobre el marcador — el marcador Hiro impreso
  // (ver marker.html) define la unidad de mundo real de AR.js: 1 unidad =
  // el ancho del marcador impreso. Los modelos de Scene3D están en
  // "unidades de escena" arbitrarias (no metros reales), así que aquí se
  // define un factor de escala aproximado para que cada equipo aparezca a
  // un tamaño de mesa razonable sobre el marcador, más el desplazamiento
  // vertical para que su base se asiente sobre el plano del marcador en
  // vez de atravesarlo. Son valores estéticos, ajustables con el gesto de
  // pellizco (pinch-to-scale) si el estudiante los quiere más grandes.
  // -----------------------------------------------------------------------
  const AR_MODEL_INFO = {
    decanter: { baseScale: 0.34, liftY: 1.20, label: "Decantador Líquido-Líquido" },
    bowl:     { baseScale: 0.40, liftY: 0.95, label: "Purificador de Tazón" },
    pump:     { baseScale: 0.46, liftY: 0.55, label: "Bomba Centrífuga" }
  };
  const SCALE_MIN = 0.4, SCALE_MAX = 2.5; // límites del gesto de pellizco (factor sobre baseScale)
  let userScale = 1;

  // -----------------------------------------------------------------------
  // §T. CONTENIDO TEÓRICO — "Mostrar teoría": al tocar un componente del
  // equipo aparece una ficha con su función, principio físico, ecuaciones,
  // variables/unidades, hipótesis del modelo y aplicaciones industriales.
  // Se indexa por equipo → clave del componente en Scene3D.dynamic[equip].
  // -----------------------------------------------------------------------
  const THEORY = {
    decanter: {
      shell: {
        nombre: "Carcasa (tazón rotatorio)",
        funcion: "Contiene ambas fases líquidas mientras giran solidariamente con el rotor.",
        principio: "Rotación de cuerpo rígido: todo el fluido gira a la misma ω, generando un campo de aceleración centrífuga ω²r que reemplaza a la gravedad como fuerza motriz de la separación.",
        ecuaciones: "P₂−P₁ = (ρω²/2)(r₂²−r₁²)",
        variables: "ρ: densidad [kg/m³] · ω: velocidad angular [rad/s] · r: radio [m]",
        hipotesis: "Flujo en rotación de cuerpo rígido, sin deslizamiento entre fluido y carcasa.",
        aplicaciones: "Separación líquido-líquido continua: aceite/agua, crudo/salmuera, extracción por solventes."
      },
      rotor: {
        nombre: "Rotor / tazón",
        funcion: "Estructura que gira y arrastra a las dos fases, generando el campo centrífugo.",
        principio: "La energía mecánica del accionamiento se transmite como aceleración centrífuga al fluido.",
        ecuaciones: "ω = 2πn/60",
        variables: "n: velocidad de rotación [rpm]",
        hipotesis: "Arranque instantáneo a ω constante en el modelo simplificado de equilibrio.",
        aplicaciones: "Común a todos los equipos centrífugos industriales."
      },
      heavyPhase: {
        nombre: "Fase pesada (ρ_A)",
        funcion: "Líquido de mayor densidad; migra hacia la pared exterior y descarga por la compuerta r_A.",
        principio: "La fuerza centrífuga es proporcional a ρ, así que la fase más densa siempre se ubica en el radio mayor en el equilibrio.",
        ecuaciones: "r_i² = (ρ_A r_A² + ρ_B r_B²)/(ρ_A + ρ_B)",
        variables: "ρ_A: densidad fase pesada [kg/m³] · r_A: radio compuerta pesada [m]",
        hipotesis: "Equilibrio hidrostático instantáneo en cada compuerta (P_atm en ambas).",
        aplicaciones: "Ej.: fase acuosa/salmuera en decantación de crudo."
      },
      lightPhase: {
        nombre: "Fase ligera (ρ_B)",
        funcion: "Líquido de menor densidad; migra hacia el eje y descarga por la compuerta r_B.",
        principio: "Análogo a la fase pesada, pero se ubica en el radio menor por tener menor ρ.",
        ecuaciones: "r_i² = (ρ_A r_A² + ρ_B r_B²)/(ρ_A + ρ_B)",
        variables: "ρ_B: densidad fase ligera [kg/m³] · r_B: radio compuerta ligera [m]",
        hipotesis: "Sin arrastre de gotas de una fase en la otra (separación ideal).",
        aplicaciones: "Ej.: fase oleosa en decantación de crudo."
      },
      iface: {
        nombre: "Interfase (r_i, zona neutra)",
        funcion: "Superficie cilíndrica que separa ambas fases; su radio de equilibrio fija el diseño de las compuertas.",
        principio: "Balance de presión: ambas columnas líquidas alcanzan P_atm en su respectiva compuerta, igualando presiones en r_i.",
        ecuaciones: "r_i² = (ρ_A r_A² + ρ_B r_B²)/(ρ_A + ρ_B)",
        variables: "r_i: radio de interfase [m]",
        hipotesis: "Válida solo si Δρ es suficiente (>3%); con Δρ menor la interfase pierde nitidez.",
        aplicaciones: "Criterio de diseño de compuertas (gate plates) en decantadores centrífugos reales."
      },
      weirA: {
        nombre: "Compuerta pesada (r_A)",
        funcion: "Anillo de rebose por donde descarga la fase pesada.",
        principio: "Su radio fija, junto con r_B, la posición de equilibrio de la interfase.",
        ecuaciones: "r_i² = (ρ_A r_A² + ρ_B r_B²)/(ρ_A + ρ_B)",
        variables: "r_A: radio de la compuerta pesada [m]",
        hipotesis: "Descarga a presión atmosférica.",
        aplicaciones: "Ajustable en equipos reales cambiando el anillo (gate ring) instalado."
      },
      weirB: {
        nombre: "Compuerta ligera (r_B)",
        funcion: "Anillo de rebose por donde descarga la fase ligera.",
        principio: "Análogo a la compuerta pesada, en el radio menor.",
        ecuaciones: "r_i² = (ρ_A r_A² + ρ_B r_B²)/(ρ_A + ρ_B)",
        variables: "r_B: radio de la compuerta ligera [m]",
        hipotesis: "Descarga a presión atmosférica.",
        aplicaciones: "Ajustable en equipos reales cambiando el anillo (gate ring) instalado."
      }
    },
    bowl: {
      shell: {
        nombre: "Carcasa del purificador",
        funcion: "Encierra el tazón rotatorio donde sedimentan los sólidos.",
        principio: "Igual que en el decantador: rotación de cuerpo rígido genera el campo centrífugo.",
        ecuaciones: "u_t = D_p²(ρ_p−ρ)ω²r / 18μ",
        variables: "ω: velocidad angular [rad/s]",
        hipotesis: "Rotación de cuerpo rígido, sin deslizamiento.",
        aplicaciones: "Clarificación de aceites, purificación de combustibles, separación de lodos."
      },
      liquidSurface: {
        nombre: "Superficie líquida cilíndrica",
        funcion: "Representa la superficie libre del líquido, que a alta ω deja de ser un plano horizontal y se vuelve un cilindro vertical.",
        principio: "A ω alta, la aceleración centrífuga (ω²r) domina completamente sobre la gravedad (g), por lo que la superficie de equilibrio sigue la geometría del campo centrífugo.",
        ecuaciones: "ω²r ≫ g",
        variables: "r: radio de la superficie libre [m]",
        hipotesis: "Régimen de alta velocidad (factor de separación Σ = ω²r/g ≫ 1).",
        aplicaciones: "Concepto base del diseño de purificadores de tazón (bowl centrifuges)."
      },
      cake: {
        nombre: "Torta de sólidos",
        funcion: "Capa de partículas acumuladas contra la pared conforme avanza el proceso por lotes.",
        principio: "Cada partícula que alcanza la pared queda retenida; con el tiempo, la torta reduce el volumen líquido disponible.",
        ecuaciones: "Modelo de acumulación asintótica: fracción = 1 − e^(−ciclos/6)",
        variables: "ciclos: número de partículas que han llegado a la pared",
        hipotesis: "Capacidad de acumulación finita en la pared (saturación suave, no del libro, es un artificio de visualización).",
        aplicaciones: "Determina la frecuencia de limpieza/descarga de sólidos del equipo real."
      },
      tracer: {
        nombre: "Partícula trazadora",
        funcion: "Representa la trayectoria radial r(t) de una partícula típica, integrada paso a paso.",
        principio: "Ley de Stokes centrífuga: la velocidad de sedimentación es proporcional a D_p², a Δρ y al campo centrífugo local ω²r.",
        ecuaciones: "dr/dt = ω² r D_p²(ρ_p−ρ) / 18μ",
        variables: "D_p: diámetro de partícula [m] · ρ_p: densidad del sólido [kg/m³] · μ: viscosidad [Pa·s]",
        hipotesis: "Régimen de Stokes válido (Re_p < 1); partícula esférica y aislada.",
        aplicaciones: "Cálculo del tiempo de residencia requerido para separación completa."
      }
    },
    pump: {
      impeller: {
        nombre: "Impulsor",
        funcion: "Componente rotatorio que transfiere energía mecánica al fluido, generando carga (ΔH) y capacidad (q).",
        principio: "Leyes de afinidad: para bombas geométricamente similares, capacidad, carga y potencia escalan con la velocidad de giro.",
        ecuaciones: "q₂/q₁ = n₂/n₁ · ΔH₂/ΔH₁ = (n₂/n₁)² · P₂/P₁ = (n₂/n₁)³",
        variables: "n: velocidad de rotación [rpm]",
        hipotesis: "Mismo diámetro de impulsor, punto de operación geométricamente semejante.",
        aplicaciones: "Base del control de bombas centrífugas mediante variadores de velocidad (VFD)."
      },
      volute: {
        nombre: "Voluta",
        funcion: "Carcasa espiral que colecta el fluido descargado por el impulsor y lo conduce hacia la tubería de descarga, convirtiendo velocidad en presión.",
        principio: "Difusión gradual del flujo: al aumentar el área de paso a lo largo de la espiral, la velocidad disminuye y la presión estática aumenta (Bernoulli).",
        ecuaciones: "P₂−P₁ = (ρω²/2)(r₂²−r₁²) — presión generada por el campo rotatorio",
        variables: "r₂: radio exterior del impulsor [m]",
        hipotesis: "Flujo incompresible, en régimen permanente.",
        aplicaciones: "Diseño estándar de bombas centrífugas de succión simple."
      },
      frontDisc: {
        nombre: "Carcasa frontal",
        funcion: "Cierra el cuerpo de la bomba; en vista industrial es opaca, en vista interior se oculta para observar el impulsor.",
        principio: "Elemento estructural/de contención, sin función hidráulica activa.",
        ecuaciones: "—",
        variables: "—",
        hipotesis: "—",
        aplicaciones: "Punto de acceso para mantenimiento del impulsor en equipos reales."
      }
    }
  };

  // -----------------------------------------------------------------------
  // §0. DETECCIÓN DE SOPORTE — se llama al cargar la página.
  //
  // AR.js necesita: (1) contexto seguro (HTTPS o localhost) porque
  // getUserMedia lo exige, y (2) la API MediaDevices.getUserMedia en sí.
  // A diferencia de WebXR, esto SÍ funciona en Safari de iOS y en
  // cualquier Android con cualquier navegador moderno — no depende de
  // ARCore/ARKit. Por eso los mensajes de error aquí son mucho más cortos
  // que en la versión WebXR: solo hay dos causas reales de fallo.
  // -----------------------------------------------------------------------
  function isSecureContext() {
    return typeof window.isSecureContext === "boolean" ? window.isSecureContext : location.protocol === "https:";
  }

  function checkSupport() {
    const btn = document.getElementById("btnAR");
    const unsupportedMsg = document.getElementById("arUnsupported");
    if (!btn) return;

    const showUnsupported = (msg) => {
      btn.style.display = "none";
      if (unsupportedMsg) {
        unsupportedMsg.textContent = msg;
        unsupportedMsg.title = msg;
        unsupportedMsg.style.display = "flex";
      }
    };

    if (!isSecureContext()) {
      showUnsupported("Realidad Aumentada requiere HTTPS · abre el simulador desde un link https:// (no http:// ni un archivo local)");
      return;
    }
    if (!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)) {
      showUnsupported("Este navegador no da acceso a la cámara · usa Chrome, Safari o Firefox actualizados");
      return;
    }

    btn.style.display = "flex";
    if (unsupportedMsg) unsupportedMsg.style.display = "none";
  }

  // -----------------------------------------------------------------------
  // §0b. DETECCIÓN MÓVIL VS. ESCRITORIO
  //
  // BUG REAL (causa raíz de "el marcador Hiro no aparece al presionar
  // 'Ver en Realidad Aumentada' desde el PC"): start() siempre intentaba
  // abrir la CÁMARA PROPIA del dispositivo que hizo clic y buscar el
  // marcador a través de ella. En un celular eso es exactamente lo que se
  // necesita (cámara trasera apuntando a un marcador impreso sobre la
  // mesa). En una PC de escritorio no tiene sentido: la webcam del PC no
  // va a "ver" ningún marcador, y en ningún punto del flujo anterior se
  // mostraba el marcador en pantalla para que un celular lo escaneara —
  // solo existía un enlace aparte ("Marcador AR") que el estudiante debía
  // recordar abrir manualmente. Aquí se distingue el dispositivo: en
  // escritorio, el botón muestra el marcador automáticamente en un modal
  // (ver showMarkerModal); en móvil, arranca la sesión de cámara real.
  // -----------------------------------------------------------------------
  function isMobileDevice() {
    const ua = navigator.userAgent || navigator.vendor || "";
    const uaLooksMobile = /Android|iPhone|iPad|iPod|Mobile|Silk|BlackBerry|IEMobile/i.test(ua);
    const coarsePointer = !!(window.matchMedia && window.matchMedia("(pointer: coarse)").matches);
    const hasTouch = ("ontouchstart" in window) || (navigator.maxTouchPoints && navigator.maxTouchPoints > 0);
    return uaLooksMobile || (coarsePointer && hasTouch);
  }

  // -----------------------------------------------------------------------
  // §0c. MODAL "MOSTRAR MARCADOR" (flujo de escritorio)
  //
  // Genera y muestra el marcador Hiro en pantalla completa a alta
  // resolución/contraste (el PNG vendorizado en assets/ar/hiro.png, el
  // mismo que usa marker.html y el mismo que rastrea el motor AR.js vía
  // assets/ar/patt.hiro — ver comentario en setupContext() más abajo).
  // Permanece visible hasta que el estudiante lo cierra explícitamente.
  // Si la imagen no carga (ruta rota, archivo faltante en el servidor),
  // se muestra un mensaje de error claro en vez de dejar un recuadro en
  // blanco.
  // -----------------------------------------------------------------------
  let markerModalEl = null;

  function hideMarkerModal() {
    if (markerModalEl) {
      markerModalEl.remove();
      markerModalEl = null;
    }
  }

  function showMarkerModal() {
    hideMarkerModal();

    const overlay = document.createElement("div");
    overlay.id = "arMarkerModal";
    overlay.style.cssText = [
      "position:fixed", "inset:0", "z-index:9999",
      "background:rgba(8,10,14,.86)", "display:flex", "align-items:center",
      "justify-content:center", "padding:24px",
      "font-family:'Space Grotesk',sans-serif"
    ].join(";");

    overlay.innerHTML = `
      <div style="background:#171C24;border:1px solid #2A313C;border-radius:16px;
                  padding:28px;max-width:420px;width:100%;display:flex;
                  flex-direction:column;align-items:center;
                  box-shadow:0 20px 50px rgba(0,0,0,.5);">
        <div style="font-family:'JetBrains Mono',monospace;font-size:11px;
                    letter-spacing:.1em;color:#4FC3D9;text-transform:uppercase;
                    margin-bottom:6px;">CENTRIX · Realidad Aumentada</div>
        <h2 style="color:#F4F1EA;font-size:18px;margin:0 0 12px;text-align:center;">
          Escanea este marcador con tu celular
        </h2>
        <img id="arMarkerModalImg" src="assets/ar/hiro.png" alt="Marcador de Realidad Aumentada Hiro"
             style="width:min(260px,60vw);height:min(260px,60vw);background:#fff;
                    border-radius:10px;image-rendering:crisp-edges;">
        <div id="arMarkerModalError" style="display:none;color:#E8664A;font-size:12.5px;
                    font-family:'JetBrains Mono',monospace;margin-top:14px;text-align:center;
                    line-height:1.6;"></div>
        <p style="color:#8A93A3;font-size:13px;line-height:1.6;text-align:center;margin:16px 0 0;">
          Abre el simulador en tu celular y presiona
          <b style="color:#F4F1EA;">"Ver en Realidad Aumentada"</b> apuntando la
          cámara trasera hacia este marcador.
        </p>
        <div style="display:flex;gap:10px;margin-top:18px;flex-wrap:wrap;justify-content:center;">
          <a href="marker.html" target="_blank" rel="noopener"
             style="font-family:'JetBrains Mono',monospace;font-size:12px;font-weight:600;
                    padding:10px 16px;border-radius:9px;border:1px solid #2A313C;
                    background:#0D1116;color:#F4F1EA;text-decoration:none;">
            Imprimir / descargar
          </a>
          <button id="arMarkerModalClose"
             style="font-family:'JetBrains Mono',monospace;font-size:12px;font-weight:600;
                    padding:10px 16px;border-radius:9px;border:1px solid #3DCB7A;
                    background:transparent;color:#3DCB7A;cursor:pointer;">
            Cerrar
          </button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);
    markerModalEl = overlay;

    const img = overlay.querySelector("#arMarkerModalImg");
    const errEl = overlay.querySelector("#arMarkerModalError");
    img.addEventListener("error", () => {
      img.style.display = "none";
      errEl.style.display = "block";
      errEl.textContent = "No se pudo cargar el marcador (assets/ar/hiro.png no respondió). Verifica que el archivo exista en el servidor y que la ruta sea correcta.";
    }, { once: true });

    const close = () => hideMarkerModal();
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
    overlay.querySelector("#arMarkerModalClose").addEventListener("click", close);

    function onEsc(e) {
      if (e.key === "Escape") { close(); document.removeEventListener("keydown", onEsc); }
    }
    document.addEventListener("keydown", onEsc);
  }

  // Punto de entrada único del botón "Ver en Realidad Aumentada": decide
  // entre el flujo de cámara real (móvil) y el flujo de marcador en
  // pantalla (escritorio), en vez de asumir siempre cámara propia.
  function handleARButtonClick() {
    if (isMobileDevice()) {
      start();
    } else {
      showMarkerModal();
    }
  }

  // -----------------------------------------------------------------------
  // §1. INICIALIZACIÓN DE LA ESCENA AR (renderer/escena/cámara propios,
  // independientes del visor 3D de escritorio) + fuente de vídeo AR.js
  // (arToolkitSource crea internamente un <video> con la cámara trasera).
  // -----------------------------------------------------------------------
  function initARScene() {
    const canvas = document.getElementById("arCanvas");
    renderer = new THREE.WebGLRenderer({
      canvas, alpha: true, antialias: true,
      // "high-performance" le pide al navegador el GPU discreta cuando el
      // dispositivo tiene una (laptops con GPU dual); en celulares no tiene
      // costo, pero evita que el sistema operativo elija el chip integrado
      // de bajo consumo por defecto cuando sí hay uno más potente disponible.
      powerPreference: "high-performance",
      stencil: false // AR.js/THREEx no usa stencil buffer; desactivarlo ahorra ancho de banda de memoria en cada frame
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(0x000000, 0);
    // Mismo color management que Scene3D (vista de escritorio) — sin esto
    // los MeshPhysicalMaterial de las mallas reparentadas se ven planos y
    // deslavados en AR aunque sean literalmente los mismos objetos.
    renderer.physicallyCorrectLights = true;
    renderer.outputEncoding = THREE.sRGBEncoding;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    // Sombras suaves (PCFSoft) — mismo criterio de calidad/rendimiento que
    // se usaría en el visor de escritorio: mapa de sombra único, de bajo
    // costo, solo para la luz clave (ver más abajo), no por cada luz.
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    scene = new THREE.Scene();
    camera = new THREE.Camera(); // THREEx.ArToolkitContext sobreescribe su matriz de proyección

    // Mismo environment map que la vista de escritorio: los materiales sin
    // envMap propio (cake, partículas, trazador) también quedan iluminados
    // de forma consistente en AR.
    if (window.Scene3D && Scene3D.envMap) scene.environment = Scene3D.envMap;

    // -------------------------------------------------------------------
    // ESQUEMA DE 3 LUCES — idéntico en espíritu al de Scene3D (vista de
    // escritorio: key blanca + fill cian + rim ámbar + ambient tenue), para
    // que el mismo equipo se vea con la MISMA identidad visual al pasar de
    // escritorio a AR. Antes AR usaba una Hemisphere+Directional genérica
    // que aplastaba los materiales metálicos (metalness alto) a un gris
    // plano sin dirección clara de luz ni definición de bordes.
    // -------------------------------------------------------------------
    scene.add(new THREE.AmbientLight(0x1a2028, 1.1));

    const key = new THREE.DirectionalLight(0xffffff, 1.15);
    key.position.set(2.4, 4.2, 2.6);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.bias = -0.0025;
    key.shadow.normalBias = 0.015;
    // El frustum de sombra se ajusta al tamaño real de los modelos sobre el
    // marcador (unidades pequeñas, <2 de lado): un frustum angosto aquí es
    // lo que da sombras nítidas sin necesidad de mapas gigantes.
    const sc = key.shadow.camera;
    sc.left = -1.6; sc.right = 1.6; sc.top = 1.6; sc.bottom = -1.6;
    sc.near = 0.5; sc.far = 8;
    scene.add(key);

    const fill = new THREE.DirectionalLight(0x4FC3D9, 0.4);
    fill.position.set(-2.5, 1.5, -1.5);
    scene.add(fill);

    const rim = new THREE.DirectionalLight(0xE8A33D, 0.45);
    rim.position.set(-1, 2.5, -3);
    scene.add(rim);

    // Ancla del marcador — THREEx.ArMarkerControls escribe la matriz de
    // este grupo cada frame para que "siga" al marcador Hiro detectado.
    markerRoot = new THREE.Group();
    markerRoot.visible = false;
    scene.add(markerRoot);

    placedRoot = new THREE.Group(); // offset de usuario (rotación/escala vía gestos)
    markerRoot.add(placedRoot);

    // La luz clave se mueve junto con el equipo colocado (hijo de
    // placedRoot) para que la sombra caiga siempre "detrás" del modelo
    // relativo a su propia orientación, sin importar cómo el estudiante
    // haya rotado el equipo con el gesto de 2 dedos.
    placedRoot.add(key);
    placedRoot.add(key.target);

    // -------------------------------------------------------------------
    // SOMBRA DE CONTACTO — un plano invisible salvo por la sombra que
    // recibe (THREE.ShadowMaterial) apoyado sobre el plano del marcador.
    // Es la señal visual más importante para que el modelo se perciba
    // "anclado" a la mesa real y no flotando sobre el video de cámara.
    // -------------------------------------------------------------------
    const shadowCatcher = new THREE.Mesh(
      new THREE.PlaneGeometry(6, 6),
      new THREE.ShadowMaterial({ opacity: 0.32 })
    );
    // El plano receptor de sombra vive directamente en markerRoot (no en
    // placedRoot): así permanece SIEMPRE apoyado sobre el papel del
    // marcador, sin importar cómo el usuario rote o incline el equipo con
    // los gestos — la sombra de contacto es la señal principal de que el
    // modelo está "anclado" a la mesa real y no puede moverse con él.
    shadowCatcher.rotation.x = -Math.PI / 2;
    shadowCatcher.position.y = 0.001; // evita z-fighting con geometría apoyada exactamente en y=0
    shadowCatcher.receiveShadow = true;
    markerRoot.add(shadowCatcher);
  }

  // El ASPECT RATIO de la fuente de vídeo y del canvas de detección DEBEN
  // coincidir. Si el canvas de detección queda en landscape mientras el
  // vídeo real es portrait (caso típico: el estudiante sostiene el
  // teléfono vertical para escanear el marcador), AR.js calcula la
  // posición del marcador contra un aspecto distinto al de la imagen que
  // realmente ve, y el modelo aparece desplazado hacia una esquina en vez
  // de centrado. Nótese que esto exige igualar la PROPORCIÓN, no el
  // número exacto de píxeles — ver detectionCanvasSize() más abajo, que
  // aprovecha justamente esa distinción para separar la resolución de
  // captura (esta función) de la resolución de detección.
  // Se pedía VGA (480×640) como techo — muy por debajo de lo que cualquier
  // cámara trasera moderna entrega, y la causa real de la "baja calidad"
  // percibida (el modelo 3D en sí ya usa mallas de 32-48 segmentos; lo que
  // se veía pixelado era el FRAME DE VIDEO de fondo, no la geometría). Se
  // sube el techo a HD (720×1280). setupContext() ya corrige estos valores
  // contra la resolución real negociada por la cámara en cuanto el <video>
  // dispara "canplay", así que esto solo cambia lo que se SOLICITA al
  // abrir getUserMedia — el dispositivo sigue entregando su nativo si es
  // mayor, y functiona igual de bien en equipos más limitados si el sensor
  // no alcanza HD.
  function sourceDimensions() {
    const landscape = window.innerWidth > window.innerHeight;
    return landscape ? { width: 1280, height: 720 } : { width: 720, height: 1280 };
  }

  // -----------------------------------------------------------------------
  // Resolución de DETECCIÓN de marcador — independiente de la resolución
  // de captura/video de sourceDimensions(). ArToolkitContext copia cada
  // fotograma a un canvas 2D interno propio (arController.canvas) y ahí
  // corre el algoritmo de detección (escala de grises, binarización,
  // búsqueda de contornos): trabajo de CPU pura, no acelerado por GPU, que
  // se repite hasta maxDetectionRate veces por segundo. Igualar ese canvas
  // a la resolución real del vídeo (que ahora puede ser HD) multiplica por
  // ~3 la carga de ese trabajo en cada frame — esa fue la causa de la
  // lentitud tras subir sourceDimensions() a HD.
  //
  // AR.js mismo trae presets internos para esto (método .performance() de
  // ArToolkitContext) que NUNCA usan la resolución real de cámara:
  // "desktop-normal" pide 640×480, "phone-normal" 320×240, "phone-slow"
  // 240×180. Aquí se replica esa misma idea a mano: se conserva el aspect
  // ratio real (necesario para la alineación del marcador, ver nota de
  // sourceDimensions) pero se limita el lado largo a AR_DETECTION_LONG_SIDE,
  // el mismo orden de magnitud que "desktop-normal" y que la configuración
  // original del proyecto (nunca reportada como lenta).
  // -----------------------------------------------------------------------
  const AR_DETECTION_LONG_SIDE = 640;
  function detectionCanvasSize(realWidth, realHeight) {
    const longSide = Math.max(realWidth, realHeight);
    const scale = Math.min(1, AR_DETECTION_LONG_SIDE / longSide);
    return {
      width: Math.round(realWidth * scale),
      height: Math.round(realHeight * scale)
    };
  }


  function initARToolkit(onReady) {
    const dims = sourceDimensions();
    arToolkitSource = new THREEx.ArToolkitSource({
      sourceType: "webcam",
      sourceWidth: dims.width,
      sourceHeight: dims.height
    });

    arToolkitSource.init(function onSourceReady() {
      // ArToolkitSource.init() inserta el <video> directamente en
      // document.body con estilos EN LÍNEA fijos (position:absolute;
      // top:0;left:0;z-index:-2). Como los estilos en línea tienen más
      // especificidad que cualquier regla de style.css, hay que
      // sobreescribirlos aquí a mano después de reparentar el elemento
      // dentro de #arVideoWrap, o el vídeo no quedará centrado/recortado
      // como especifica la hoja de estilos.
      const wrap = document.getElementById("arVideoWrap");
      const video = arToolkitSource.domElement;
      if (wrap && video) {
        // Safari de iOS exige playsinline (y en la práctica también muted)
        // para reproducir el <video> de la cámara sin forzar pantalla
        // completa nativa; sin esto el feed de cámara nunca aparece en
        // Safari aunque el permiso se haya concedido.
        video.setAttribute("playsinline", "");
        video.setAttribute("webkit-playsinline", "");
        video.muted = true;
        wrap.innerHTML = "";
        wrap.appendChild(video);
        // Solo lo esencial: la geometría real (posición/tamaño cover) la
        // fija layoutCoverAR() en cuanto se conoce la resolución nativa.
        video.style.position = "fixed";
        video.style.top = "0";
        video.style.left = "0";
        video.style.zIndex = "0";
      }
      arToolkitSource.domElement.addEventListener("canplay", () => {
        setupContext(onReady);
      }, { once: true });
      // canplay puede ya haber ocurrido si la cámara respondió muy rápido
      setTimeout(onResizeAR, 400);
      // Segundo pase de layout: en iOS videoWidth/videoHeight puede tardar
      // un instante más en reflejar la orientación definitiva del sensor.
      setTimeout(layoutCoverAR, 900);
    }, function onSourceError(err) {
      onCameraError(err);
    });

    window.addEventListener("resize", onResizeAR);
  }

  // -----------------------------------------------------------------------
  // ENCUADRE "COVER" UNIFICADO — video + canvas + buffer WebGL
  // ---------------------------------------------------------------------
  // Historia del bug: el <video> quedaba en object-fit:contain (franjas
  // negras) mientras el canvas 3D se dimensionaba con el cover-crop de la
  // librería (onResizeElement/copyElementSizeTo). Dos geometrías DISTINTAS
  // para dos capas que deben coincidir píxel a píxel → el modelo aparecía
  // desplazado/escalado respecto al marcador y en móvil la cámara se veía
  // "con orientación de escritorio" o recortada.
  //
  // Solución: UNA sola función calcula el cover-crop (el fotograma llena
  // la pantalla completa sin deformarse, recortando lo que sobra) usando
  // la resolución REAL del video (videoWidth/videoHeight, que el navegador
  // ya entrega con la orientación correcta del sensor en portrait o
  // landscape) y aplica exactamente la misma posición/tamaño al <video> y
  // al <canvas>. Como ambos comparten aspecto con el fotograma que usa la
  // matriz de proyección de AR.js, la alineación modelo↔marcador se
  // conserva en cualquier orientación del teléfono, sin franjas negras.
  //
  // Además corrige un bug de NITIDEZ que existía desde el principio: el
  // buffer de dibujo del renderer AR nunca se redimensionaba
  // (renderer.setSize no se llamaba en ninguna parte), así que Three.js
  // renderizaba al tamaño por defecto del canvas (300×150) y el CSS lo
  // estiraba a pantalla completa: el modelo se veía pixelado sin importar
  // la calidad de las mallas. Aquí el buffer se ajusta al tamaño visible
  // real (× pixel ratio), que es lo que da el render nítido "industrial".
  // -----------------------------------------------------------------------
  function layoutCoverAR() {
    if (!arToolkitSource || !renderer) return;
    const video = arToolkitSource.domElement;
    if (!video) return;

    const vw = video.videoWidth || arToolkitSource.parameters.sourceWidth || 1280;
    const vh = video.videoHeight || arToolkitSource.parameters.sourceHeight || 720;
    const sw = window.innerWidth, sh = window.innerHeight;

    const scale = Math.max(sw / vw, sh / vh); // cover: llena la pantalla, recorta el excedente
    const w = Math.round(vw * scale);
    const h = Math.round(vh * scale);
    const left = Math.round((sw - w) / 2);
    const top = Math.round((sh - h) / 2);

    const canvas = renderer.domElement;
    [video, canvas].forEach((el) => {
      el.style.position = "fixed";
      el.style.width = `${w}px`;
      el.style.height = `${h}px`;
      el.style.left = `${left}px`;
      el.style.top = `${top}px`;
      el.style.margin = "0";
      el.style.transform = "none";
      el.style.objectFit = "";
      el.style.minWidth = "0";
      el.style.minHeight = "0";
    });

    // Buffer de dibujo del canvas 3D = tamaño visible (setPixelRatio ya
    // está fijado en initARScene; false = no tocar el style que acabamos
    // de calcular a mano).
    renderer.setSize(w, h, false);
  }

  function setupContext(onReady) {
    // FIX centrado del modelo — usar la resolución REAL negociada por la
    // cámara (video.videoWidth/videoHeight) en vez de la solicitada.
    // Muchos navegadores móviles ignoran sourceWidth/sourceHeight y
    // entregan su propia resolución nativa (a menudo landscape incluso con
    // el teléfono en vertical). Si el aspect ratio usado para la detección
    // no coincide con el del fotograma real de vídeo, el marcador se
    // detecta contra un sistema de coordenadas distinto al que se ve en
    // pantalla: el resultado es el modelo desplazado hacia una esquina, con
    // aspecto aplastado/visto desde un ángulo raro, en vez de centrado
    // sobre el marcador. Al llegar aquí ("canplay" ya disparó) el <video>
    // ya tiene su resolución real disponible.
    const video = arToolkitSource && arToolkitSource.domElement;
    const dims = (video && video.videoWidth) ? { width: video.videoWidth, height: video.videoHeight } : sourceDimensions();

    // Corrige también los parámetros internos de la fuente para que
    // onResizeElement()/copyElementSizeTo() (llamados en cada resize)
    // calculen el recorte/escala del <video> contra el tamaño real, no
    // contra el que se pidió al abrir la cámara.
    if (arToolkitSource) {
      arToolkitSource.parameters.sourceWidth = dims.width;
      arToolkitSource.parameters.sourceHeight = dims.height;
    }

    const detDims = detectionCanvasSize(dims.width, dims.height);
    arToolkitContext = new THREEx.ArToolkitContext({
      cameraParametersUrl: "assets/ar/camera_para.dat",
      detectionMode: "mono",
      maxDetectionRate: 30,
      canvasWidth: detDims.width,
      canvasHeight: detDims.height
    });

    arToolkitContext.init(() => {
      camera.projectionMatrix.copy(arToolkitContext.getProjectionMatrix());
      window.arToolkitContext = arToolkitContext;

      const markerControls = new THREEx.ArMarkerControls(arToolkitContext, markerRoot, {
        type: "pattern",
        patternUrl: "assets/ar/patt.hiro",
        changeMatrixMode: "modelViewMatrix",
        // Suavizado de pose más fuerte que el original (smoothCount 5→8):
        // promedia más muestras antes de mover el modelo, así el jitter de
        // detección frame a frame (mano temblando, luz variable) no se
        // traduce en un modelo que "vibra" sobre el marcador. El costo es
        // unos pocos frames más de latencia al aparecer, imperceptible
        // frente a la mejora de estabilidad visual.
        smooth: true,
        smoothCount: 8,
        smoothTolerance: 0.01,
        smoothThreshold: 3
      });

      markerRoot.addEventListener("markerFound", onMarkerFound);
      markerRoot.addEventListener("markerLost", onMarkerLost);

      onResizeAR();
      if (onReady) onReady();
    });
  }

  function onResizeAR() {
    if (!arToolkitSource) return;

    // Si la orientación real del dispositivo cambió (portrait↔landscape)
    // mientras la sesión está corriendo, un simple resize NO alcanza: hay
    // que reconstruir arToolkitSource/arToolkitContext contra el nuevo
    // aspecto (ver comentario junto a lastOrientationLandscape más arriba).
    const landscapeNow = isLandscapeNow();
    if (running && lastOrientationLandscape !== null && landscapeNow !== lastOrientationLandscape) {
      lastOrientationLandscape = landscapeNow;
      clearTimeout(orientationRestartTimer);
      // Pequeño debounce: en iOS/Android el evento "resize" puede disparar
      // varias veces seguidas mientras la rotación de pantalla termina de
      // animarse; se espera a que se estabilice antes de reconstruir.
      orientationRestartTimer = setTimeout(restartARForOrientationChange, 250);
      return;
    }
    lastOrientationLandscape = landscapeNow;

    // NOTA: ya NO se llama a arToolkitSource.onResizeElement() ni a
    // copyElementSizeTo(): esas funciones de la librería aplican su propio
    // criterio de tamaño (solo CSS, sin tocar el buffer WebGL y sin tener
    // en cuenta la orientación real del sensor), y pisaban el layout
    // correcto. layoutCoverAR() reemplaza a ambas con una única geometría
    // compartida por video y canvas. El canvas interno de DETECCIÓN
    // (arController.canvas) es offscreen: su CSS es irrelevante y su
    // resolución de trabajo ya quedó fijada en setupContext().
    if (arToolkitContext && arToolkitContext.arController) {
      // La matriz de proyección se refresca en cada resize para que el
      // render 3D siga calzando con el fotograma de video de fondo.
      camera.projectionMatrix.copy(arToolkitContext.getProjectionMatrix());
    }
    layoutCoverAR();
  }

  // Reconstruye únicamente la fuente de vídeo y el contexto de detección
  // de AR.js contra la orientación actual, SIN tocar la escena Three.js
  // (equipGroup/placedRoot/markerRoot se conservan): el estudiante no
  // pierde la colocación/escala/rotación que ya había ajustado con gestos.
  function restartARForOrientationChange() {
    if (!running) return;

    window.removeEventListener("resize", onResizeAR);
    if (arToolkitSource && arToolkitSource.domElement) {
      const el = arToolkitSource.domElement;
      if (el.srcObject) el.srcObject.getTracks().forEach((t) => t.stop());
      if (el.parentNode) el.parentNode.removeChild(el);
    }
    if (markerRoot) {
      markerRoot.removeEventListener("markerFound", onMarkerFound);
      markerRoot.removeEventListener("markerLost", onMarkerLost);
      markerRoot.visible = false;
    }
    arToolkitSource = null;
    arToolkitContext = null;
    clearTimeout(markerLostTimer);
    markerLostTimer = null;
    markerVisible = false;
    if (placedRoot) placedRoot.visible = false;

    const wrap = document.getElementById("arVideoWrap");
    if (wrap) wrap.innerHTML = "";
    const hint = document.getElementById("arHint");
    if (hint) { hint.textContent = "Apunta la cámara hacia el marcador Hiro impreso · descárgalo en marker.html"; hint.style.display = "block"; }

    initARToolkit(() => { /* la sesión sigue activa; solo se recalibró la detección */ });
  }

  function onCameraError(err) {
    let msg = "No se pudo acceder a la cámara. Verifica los permisos del sitio.";
    if (err && err.name === "NotAllowedError") {
      msg = "Permiso de cámara denegado · actívalo en los ajustes del sitio y vuelve a intentar";
    } else if (err && err.name === "NotFoundError") {
      msg = "No se detectó ninguna cámara en este dispositivo";
    } else if (err && err.name === "NotReadableError") {
      msg = "La cámara está siendo usada por otra aplicación";
    }
    showToast(msg);
    stop();
  }

  // -----------------------------------------------------------------------
  // §2. DETECCIÓN DEL MARCADOR — muestra/oculta el equipo con un pequeño
  // debounce (ver MARKER_LOST_DELAY) para que oclusiones breves no hagan
  // parpadear el modelo.
  // -----------------------------------------------------------------------
  function onMarkerFound() {
    clearTimeout(markerLostTimer);
    markerLostTimer = null;
    if (!markerVisible) {
      markerVisible = true;
      if (placedRoot) placedRoot.visible = true;
      const hint = document.getElementById("arHint");
      if (hint) hint.style.display = "none";
    }
  }

  function onMarkerLost() {
    if (markerLostTimer) return;
    markerLostTimer = setTimeout(() => {
      markerVisible = false;
      if (placedRoot) placedRoot.visible = false;
      const hint = document.getElementById("arHint");
      if (hint) hint.style.display = "block";
      markerLostTimer = null;
    }, MARKER_LOST_DELAY);
  }

  // -----------------------------------------------------------------------
  // INCLINACIÓN DE PRESENTACIÓN — en AR de marcador, el modelo queda fijo
  // al plano del marcador; si el estudiante sostiene el celular casi en
  // vertical sobre una mesa (lo natural para escanear un marcador plano),
  // la cámara mira el equipo casi en picada y se ve "aplastado"/desde
  // arriba, muy distinto al ángulo 3/4 fijo del visor de escritorio
  // (Scene3D usa phi≈60° desde el eje Y, es decir ~30° de elevación sobre
  // el horizonte). Como en AR no podemos mover la cámara (es la cámara
  // real del celular), se compensa inclinando el propio modelo hacia el
  // usuario un ángulo fijo, así con el ángulo típico de escaneo se
  // aproxima a esa misma vista de "hero shot" del escritorio. El gesto de
  // giro (2 dedos) rota sobre Y por encima de esta base, así que la
  // inclinación se conserva mientras el estudiante gira el equipo.
  // -----------------------------------------------------------------------
  // NOTA DE SIGNO: en Three.js, rotation.x POSITIVO inclina la parte
  // superior del objeto alejándose de la cámara (la base sube hacia el
  // usuario) — es la inclinación INVERSA a la buscada aquí, y es la causa
  // de que el equipo apareciera "de cabeza" en AR. Para inclinar la parte
  // superior HACIA la cámara (el hero-shot 3/4 del escritorio) el ángulo
  // debe ser NEGATIVO. Se deja AR_TILT_DEG en positivo (más intuitivo de
  // leer/ajustar) y se aplica el signo una sola vez aquí.
  const AR_TILT_DEG = 58; // ajustable a gusto: más alto = modelo más "de pie" hacia la cámara
  const AR_TILT_X = -THREE.MathUtils.degToRad(AR_TILT_DEG);

  // -----------------------------------------------------------------------
  // §3. ARRANQUE / FIN DE SESIÓN
  // -----------------------------------------------------------------------
  // Cuánto esperar a que initARToolkit() confirme que el marcador/cámara
  // quedaron listos antes de asumir que algo falló silenciosamente (por
  // ejemplo, assets/ar/patt.hiro o assets/ar/camera_para.dat con 404, o el
  // navegador negando el permiso de cámara sin disparar onSourceError).
  // Sin esto, un fallo de carga dejaba la pantalla en negro sin ningún
  // mensaje — ahora se avisa y se cierra la sesión de forma controlada.
  const AR_INIT_TIMEOUT_MS = 12000;
  let startWatchdog = null;

  function start() {
    if (running) return;

    // BUG REAL: si arjs-threex.js no cargó (red bloqueada, CDN caído, ruta
    // libs/arjs-threex.js rota), THREEx queda undefined y el resto de esta
    // función explota con una excepción no capturada — la pantalla se
    // queda en negro sin ningún aviso. Se valida aquí antes de tocar nada.
    if (typeof THREE === "undefined" || typeof THREEx === "undefined") {
      showToast("No se pudo cargar la librería de Realidad Aumentada (arjs-threex.js) · revisa tu conexión y recarga la página");
      return;
    }

    const overlay = document.getElementById("arOverlay");
    const videoWrap = document.getElementById("arVideoWrap");

    document.getElementById("arCanvas").style.display = "block";
    if (videoWrap) videoWrap.style.display = "block";
    if (overlay) overlay.style.display = "flex";
    const hint = document.getElementById("arHint");
    if (hint) { hint.textContent = "Apunta la cámara hacia el marcador Hiro impreso · descárgalo en marker.html"; hint.style.display = "block"; }

    if (!renderer) initARScene();
    Scene3D.setRenderPaused(true); // deja de renderizar (no de calcular) el canvas principal oculto

    attachEquipGroup();
    if (placedRoot) placedRoot.rotation.set(AR_TILT_X, 0, 0);
    setupGestures();
    updateOverlayEquipLabel();
    syncARTransportUI();
    if (arParamsOpen) buildARParamsPanel();

    clearTimeout(startWatchdog);
    startWatchdog = setTimeout(() => {
      if (!running) {
        showToast("No se pudo inicializar el seguimiento del marcador Hiro (verifica assets/ar/patt.hiro y assets/ar/camera_para.dat) · vuelve a intentarlo");
        stop();
      }
    }, AR_INIT_TIMEOUT_MS);

    initARToolkit(() => {
      clearTimeout(startWatchdog);
      running = true;
      rafId = requestAnimationFrame(renderLoop);
    });
  }

  function stop() {
    clearTimeout(startWatchdog);
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;
    running = false;

    window.removeEventListener("resize", onResizeAR);
    clearTimeout(markerLostTimer);
    markerLostTimer = null;
    markerVisible = false;
    clearTimeout(orientationRestartTimer);
    orientationRestartTimer = null;
    lastOrientationLandscape = null;

    if (arToolkitSource && arToolkitSource.domElement) {
      const el = arToolkitSource.domElement;
      if (el.srcObject) {
        el.srcObject.getTracks().forEach((t) => t.stop());
      }
      if (el.parentNode) el.parentNode.removeChild(el);
    }
    arToolkitSource = null;
    arToolkitContext = null;

    if (markerRoot) {
      markerRoot.removeEventListener("markerFound", onMarkerFound);
      markerRoot.removeEventListener("markerLost", onMarkerLost);
    }

    detachEquipGroup();
    teardownGestures();

    document.getElementById("arCanvas").style.display = "none";
    const videoWrap = document.getElementById("arVideoWrap");
    if (videoWrap) { videoWrap.style.display = "none"; videoWrap.innerHTML = ""; }
    const overlay = document.getElementById("arOverlay");
    if (overlay) overlay.style.display = "none";
    hideTheoryCard();
    const panel = document.getElementById("arReadoutPanel");
    if (panel) panel.style.display = "none";

    Scene3D.setRenderPaused(false); // el visor 3D de escritorio vuelve a renderizar normalmente

    // La escena AR (renderer/markerRoot) se conserva entre sesiones para
    // no reconstruir WebGL en cada entrada/salida; solo se resetea el
    // estado de colocación del usuario.
    userScale = 1;
    yawVelocity = 0;
    if (placedRoot) { placedRoot.visible = false; placedRoot.rotation.set(0, 0, 0); placedRoot.position.set(0, 0, 0); }

    // Cierra el panel de parámetros AR y el menú de opciones si quedaron
    // abiertos, para que la próxima sesión empiece limpia.
    arParamsOpen = false;
    const paramsPanel = document.getElementById("arParamsPanel");
    if (paramsPanel) paramsPanel.style.display = "none";
    const btnParamsToggle = document.getElementById("arToggleParams");
    if (btnParamsToggle) btnParamsToggle.classList.remove("active");
    closeOptionsMenu();
  }

  // -----------------------------------------------------------------------
  // §4. REPARENTADO DEL MODELO ACTIVO — mueve Scene3D.groups[equip] desde
  // la escena principal a la escena AR (y de vuelta al terminar). No se
  // clona geometría: son las mismas mallas que anima el motor de
  // simulación, por eso RPM/interfase/trazador/arranque de bomba se ven
  // sincronizados automáticamente sin código adicional.
  // -----------------------------------------------------------------------
  function attachEquipGroup(equipOverride) {
    const equip = equipOverride || Scene3D.currentEquip;
    equipGroup = Scene3D.groups[equip];
    equipParentOriginal = Scene3D.scene;
    equipOriginalTransform = {
      position: equipGroup.position.clone(),
      rotation: equipGroup.rotation.clone(),
      scale: equipGroup.scale.clone(),
      visible: equipGroup.visible
    };

    const info = AR_MODEL_INFO[equip];
    equipGroup.visible = true;
    // Orientación inicial de frente al usuario: rotation en (0,0,0) sobre
    // sus propios ejes locales — nunca se aplica ninguna rotación arbitraria
    // aquí; la única inclinación viene de placedRoot (ver AR_TILT_X), así
    // que el modelo siempre arranca mirando de frente a la cámara.
    equipGroup.position.set(0, info.liftY * info.baseScale * userScale, 0);
    equipGroup.rotation.set(0, 0, 0);
    equipGroup.scale.setScalar(info.baseScale * userScale);
    equipGroup.traverse((node) => {
      if (!node.isMesh) return;
      // Solo las piezas OPACAS proyectan sombra: Three.js no atenúa la
      // sombra según la transparencia del material, así que las fases
      // líquidas/carcasas traslúcidas proyectarían siluetas negras
      // sólidas irreales sobre el plano del marcador.
      node.castShadow = !(node.material && node.material.transparent);
      node.receiveShadow = false;
    });
    placedRoot.add(equipGroup); // reparenta: Three.js lo quita automáticamente de la escena principal
  }

  function detachEquipGroup() {
    if (!equipGroup) return;
    equipGroup.position.copy(equipOriginalTransform.position);
    equipGroup.rotation.copy(equipOriginalTransform.rotation);
    equipGroup.scale.copy(equipOriginalTransform.scale);
    equipGroup.visible = equipOriginalTransform.visible;
    equipParentOriginal.add(equipGroup); // lo devuelve a la escena principal
    equipGroup = null;
  }

  // Cambiar de equipo SIN salir de la sesión AR (menú "Seleccionar equipo").
  function switchEquip(name) {
    if (!running || !AR_MODEL_INFO[name]) return;
    detachEquipGroup();
    attachEquipGroup(name);
    // Centrix.switchEquip mantiene sincronizados currentEquip en main.js, el
    // panel de parámetros de escritorio y las gráficas — antes esto solo
    // llamaba a Scene3D.setEquip() y el equipo mostrado en AR quedaba
    // desincronizado del estado que realmente se editaba/graficaba.
    if (window.Centrix) Centrix.switchEquip(name); else Scene3D.setEquip(name);
    updateOverlayEquipLabel();
    if (arParamsOpen) buildARParamsPanel();
  }

  // -----------------------------------------------------------------------
  // §5. GESTOS TÁCTILES — 1 dedo = mover el equipo sobre el plano del
  // marcador (antes solo rotaba: el estudiante no podía recentrarlo sin
  // mover el marcador impreso), 2 dedos = pellizco para escalar + giro
  // para rotar (yaw), toque simple = inspeccionar componente (si "Mostrar
  // teoría" está activo).
  // -----------------------------------------------------------------------
  const TAP_MOVE_THRESHOLD = 12;  // px — por debajo de esto, un toque cuenta como "tap" y no como arrastre
  const ROTATE_SPEED = 0.008;     // rad por píxel arrastrado (1 dedo, giro horizontal)
  const PITCH_SPEED = 0.005;      // rad por píxel arrastrado (1 dedo, inclinación vertical)
  const PITCH_RANGE = 0.6;        // rad — límite de inclinación alrededor del tilt base (evita voltear el modelo)
  const TRANSLATE_SPEED = 0.0022; // unidades de mundo AR por píxel arrastrado (2 dedos, pan)
  const YAW_DAMPING = 0.93;       // fricción de la inercia de giro (por frame)
  let gestureStartAngle = null;
  let gestureStartRotationY = 0;
  let gestureLastMid = null;      // punto medio previo del gesto de 2 dedos (para pan)
  let yawVelocity = 0;            // rad/frame — inercia acumulada del giro de 1 dedo

  function setupGestures() {
    const canvas = document.getElementById("arCanvas");
    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointercancel", onPointerUp);
  }
  function teardownGestures() {
    const canvas = document.getElementById("arCanvas");
    canvas.removeEventListener("pointerdown", onPointerDown);
    canvas.removeEventListener("pointermove", onPointerMove);
    canvas.removeEventListener("pointerup", onPointerUp);
    canvas.removeEventListener("pointercancel", onPointerUp);
    pointers.clear();
  }

  function onPointerDown(e) {
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    yawVelocity = 0; // tocar la pantalla frena de inmediato cualquier inercia en curso
    if (pointers.size === 1) {
      tapCandidate = { x: e.clientX, y: e.clientY, moved: false };
    } else {
      tapCandidate = null; // dos dedos en pantalla: ya no puede ser un "tap" simple
    }
    if (pointers.size === 2) {
      const pts = [...pointers.values()];
      gestureStartDist = dist(pts[0], pts[1]);
      gestureStartScale = userScale;
      gestureStartAngle = angleBetween(pts[0], pts[1]);
      gestureStartRotationY = placedRoot ? placedRoot.rotation.y : 0;
      gestureLastMid = null;
    }
  }

  function onPointerMove(e) {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointers.size === 1 && placedRoot && placedRoot.visible) {
      const p = pointers.get(e.pointerId);
      if (tapCandidate) {
        const dx = p.x - tapCandidate.x, dy = p.y - tapCandidate.y;
        if (Math.hypot(dx, dy) > TAP_MOVE_THRESHOLD) tapCandidate.moved = true;
        if (tapCandidate.moved) {
          // ROTACIÓN LIBRE CON 1 DEDO — arrastre horizontal gira el equipo
          // sobre su eje vertical; arrastre vertical lo inclina hacia/lejos
          // de la cámara, acotado a ±PITCH_RANGE alrededor del tilt base
          // para que nunca quede de cabeza. El delta horizontal alimenta
          // además yawVelocity: al soltar, el giro continúa con inercia y
          // se frena suavemente (ver renderLoop), lo que da la sensación
          // fluida/natural de "empujar" un objeto real.
          placedRoot.rotation.y += dx * ROTATE_SPEED;
          placedRoot.rotation.x = Math.min(
            Math.max(placedRoot.rotation.x + dy * PITCH_SPEED, AR_TILT_X - PITCH_RANGE),
            AR_TILT_X + PITCH_RANGE
          );
          yawVelocity = dx * ROTATE_SPEED;
          tapCandidate.x = p.x; tapCandidate.y = p.y; // acumula solo el delta de este frame
        }
      }
    } else if (pointers.size === 2) {
      const pts = [...pointers.values()];
      const d = dist(pts[0], pts[1]);
      if (gestureStartDist) {
        const scaleFactor = d / gestureStartDist;
        userScale = Math.min(Math.max(gestureStartScale * scaleFactor, SCALE_MIN), SCALE_MAX);
        applyUserScale();
      }
      if (gestureStartAngle !== null && placedRoot) {
        const angle = angleBetween(pts[0], pts[1]);
        placedRoot.rotation.y = gestureStartRotationY + (angle - gestureStartAngle);
      }
      // Pan con 2 dedos — el punto medio del gesto arrastra el equipo
      // sobre el plano del marcador (X/Z), para recentrarlo sin mover el
      // papel impreso. Antes esto vivía en el gesto de 1 dedo; se movió
      // aquí para dejar el dedo único dedicado a la rotación libre.
      const mid = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
      if (gestureLastMid && placedRoot) {
        placedRoot.position.x += (mid.x - gestureLastMid.x) * TRANSLATE_SPEED;
        placedRoot.position.z += (mid.y - gestureLastMid.y) * TRANSLATE_SPEED;
      }
      gestureLastMid = mid;
    }
  }

  function onPointerUp(e) {
    const wasTap = tapCandidate && !tapCandidate.moved && pointers.size === 1;
    pointers.delete(e.pointerId);
    if (pointers.size < 2) { gestureStartDist = null; gestureStartAngle = null; gestureLastMid = null; }

    if (wasTap) handleTap(tapCandidate.x, tapCandidate.y);
    if (pointers.size === 0) tapCandidate = null;
  }

  function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
  function angleBetween(a, b) { return Math.atan2(b.y - a.y, b.x - a.x); }

  function applyUserScale() {
    if (!equipGroup) return;
    const equip = Scene3D.currentEquip;
    const info = AR_MODEL_INFO[equip];
    const s = info.baseScale * userScale;
    equipGroup.scale.setScalar(s);
    equipGroup.position.y = info.liftY * s;
  }

  // -----------------------------------------------------------------------
  // §6. MANEJO DEL TOQUE — en modo teoría, dispara un raycast contra los
  // componentes del equipo activo para mostrar la ficha didáctica del que
  // fue tocado.
  // -----------------------------------------------------------------------
  const raycaster = new THREE.Raycaster();
  function handleTap(clientX, clientY) {
    if (theoryMode && placedRoot && placedRoot.visible) {
      pickComponent(clientX, clientY);
    }
  }

  function pickComponent(clientX, clientY) {
    const canvas = document.getElementById("arCanvas");
    const rect = canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1
    );
    raycaster.setFromCamera(ndc, camera);

    const equip = Scene3D.currentEquip;
    const dyn = Scene3D.dynamic[equip] || {};
    const theoryForEquip = THEORY[equip] || {};
    const candidates = [];
    Object.keys(theoryForEquip).forEach((key) => {
      const obj = dyn[key];
      if (obj && obj.isObject3D) candidates.push({ key, obj });
    });

    const hits = raycaster.intersectObjects(candidates.map(c => c.obj), true);
    if (hits.length === 0) return;
    const hitObj = hits[0].object;

    // Varios candidatos pueden ser ancestro unos de otros (p. ej. "rotor"
    // contiene a "heavyPhase", "iface", etc.). Se elige el candidato MÁS
    // ESPECÍFICO: el que está a menor distancia (en niveles del árbol) del
    // objeto realmente golpeado por el rayo, no el primero en declararse.
    let best = null, bestDepth = Infinity;
    candidates.forEach((c) => {
      const d = depthTo(c.obj, hitObj);
      if (d < bestDepth) { bestDepth = d; best = c; }
    });
    if (best) showTheoryCard(theoryForEquip[best.key]);
  }

  // Distancia (en niveles) entre `node` y su ancestro `root`; 0 si son el
  // mismo objeto, Infinity si `root` no es ancestro de `node`.
  function depthTo(root, node) {
    let d = 0, p = node;
    while (p) { if (p === root) return d; p = p.parent; d++; }
    return Infinity;
  }

  // -----------------------------------------------------------------------
  // §7. LOOP DE RENDER — actualiza el contexto de tracking de AR.js cada
  // frame (arToolkitContext.update procesa el fotograma de vídeo actual y
  // dispara markerFound/markerLost internamente), proyecta las etiquetas
  // flotantes (billboards) y refresca el panel de lecturas en vivo.
  // -----------------------------------------------------------------------
  function renderLoop() {
    rafId = requestAnimationFrame(renderLoop);
    if (arToolkitSource && arToolkitSource.ready && arToolkitContext) {
      arToolkitContext.update(arToolkitSource.domElement);
    }
    // Inercia del gesto de rotación de 1 dedo: al soltar, el giro continúa
    // y se frena exponencialmente (fricción), como un objeto físico real.
    if (Math.abs(yawVelocity) > 0.0004 && pointers.size === 0 && placedRoot) {
      placedRoot.rotation.y += yawVelocity;
      yawVelocity *= YAW_DAMPING;
    } else if (pointers.size === 0) {
      yawVelocity = 0;
    }
    updateBillboards();
    renderer.render(scene, camera);
  }

  // -----------------------------------------------------------------------
  // §8. ETIQUETAS FLOTANTES (billboards) — panel HTML de lecturas en vivo
  // anclado sobre el modelo colocado. Se recalcula su posición en pantalla
  // proyectando un punto 3D sobre el equipo con la cámara AR de cada
  // frame, así que sigue al modelo mientras el marcador se mueve.
  // -----------------------------------------------------------------------
  const projVec = new THREE.Vector3();
  // El CONTENIDO del panel (innerHTML) se reconstruye como máximo cada
  // BILLBOARD_CONTENT_INTERVAL ms en vez de en cada uno de los ~60 frames
  // por segundo del renderLoop: las lecturas numéricas cambian a un ritmo
  // mucho más lento que el refresco de pantalla, así que reconstruir el
  // string HTML completo cada frame era trabajo de CPU/DOM desperdiciado
  // (layout thrashing) que competía por el mismo hilo principal que el
  // tracking del marcador. La POSICIÓN del panel sí se recalcula cada
  // frame, para que siga al modelo sin saltos perceptibles.
  const BILLBOARD_CONTENT_INTERVAL = 200;
  let lastBillboardContentAt = 0;

  function updateBillboards() {
    const panel = document.getElementById("arReadoutPanel");
    if (!panel) return;
    if (!labelsOn || !placedRoot || !placedRoot.visible || !markerRoot.visible) { panel.style.display = "none"; return; }

    const equip = Scene3D.currentEquip;
    const info = AR_MODEL_INFO[equip];
    const anchorHeight = info.liftY * info.baseScale * userScale * 2.1;
    const worldPoint = placedRoot.localToWorld(projVec.set(0, anchorHeight, 0));

    const p = worldPoint.clone().project(camera);
    if (p.z > 1) { panel.style.display = "none"; return; } // detrás de la cámara

    const canvas = document.getElementById("arCanvas");
    const x = (p.x * 0.5 + 0.5) * canvas.clientWidth;
    const y = (-p.y * 0.5 + 0.5) * canvas.clientHeight;

    panel.style.display = "block";
    panel.style.left = `${x}px`;
    panel.style.top = `${y}px`;

    const now = performance.now();
    if (now - lastBillboardContentAt < BILLBOARD_CONTENT_INTERVAL) return;
    lastBillboardContentAt = now;

    // Contenido — se toma directamente de la última lectura calculada por
    // main.js (cacheada en ui.js), así nunca se desincroniza del panel de
    // datos del visor de escritorio.
    const last = UI.getLastState();
    panel.innerHTML = `
      <div class="ar-panel-title">${info.label}</div>
      ${last.readouts.slice(0, 4).map(r => `
        <div class="ar-panel-row"><span>${r.label}</span><b>${r.value}${r.unit ? ` ${r.unit}` : ""}</b></div>
      `).join("")}
    `;
  }

  // -----------------------------------------------------------------------
  // §9. TARJETA DE TEORÍA (modo didáctico)
  // -----------------------------------------------------------------------
  function showTheoryCard(t) {
    const card = document.getElementById("arTheoryCard");
    if (!card || !t) return;
    card.innerHTML = `
      <button class="ar-theory-close" id="arTheoryClose" aria-label="Cerrar">✕</button>
      <div class="ar-theory-name">${t.nombre}</div>
      <div class="ar-theory-row"><b>Función</b><span>${t.funcion}</span></div>
      <div class="ar-theory-row"><b>Principio físico</b><span>${t.principio}</span></div>
      <div class="ar-theory-row"><b>Ecuación</b><span class="ar-theory-eq">${t.ecuaciones}</span></div>
      <div class="ar-theory-row"><b>Variables</b><span>${t.variables}</span></div>
      <div class="ar-theory-row"><b>Hipótesis</b><span>${t.hipotesis}</span></div>
      <div class="ar-theory-row"><b>Aplicaciones</b><span>${t.aplicaciones}</span></div>
    `;
    card.style.display = "block";
    document.getElementById("arTheoryClose").addEventListener("click", hideTheoryCard);
  }
  function hideTheoryCard() {
    const card = document.getElementById("arTheoryCard");
    if (card) card.style.display = "none";
  }

  // -----------------------------------------------------------------------
  // §10. CONTROLES DEL OVERLAY (salir, reiniciar posición, etiquetas, teoría)
  // -----------------------------------------------------------------------
  function resetPlacement() {
    userScale = 1;
    yawVelocity = 0;
    if (placedRoot) { placedRoot.rotation.set(AR_TILT_X, 0, 0); placedRoot.position.set(0, 0, 0); }
    applyUserScale();
    hideTheoryCard();
  }

  function toggleLabels(v) {
    labelsOn = v;
    if (!v) {
      const panel = document.getElementById("arReadoutPanel");
      if (panel) panel.style.display = "none";
    }
  }

  function toggleTheory(v) {
    theoryMode = v;
    if (!v) hideTheoryCard();
  }

  function closeOptionsMenu() {
    const menu = document.getElementById("arOptionsMenu");
    const btn = document.getElementById("arToggleOptions");
    if (menu) menu.style.display = "none";
    if (btn) { btn.setAttribute("aria-expanded", "false"); btn.classList.remove("active"); }
  }

  function updateOverlayEquipLabel() {
    const el = document.getElementById("arEquipLabel");
    if (el) el.textContent = AR_MODEL_INFO[Scene3D.currentEquip].label;
  }

  function showToast(msg) {
    const t = document.getElementById("arToast");
    if (!t) { alert(msg); return; }
    t.textContent = msg;
    t.style.display = "block";
    clearTimeout(showToast._tid);
    showToast._tid = setTimeout(() => { t.style.display = "none"; }, 3500);
  }

  // -----------------------------------------------------------------------
  // §11b. PANEL DE PARÁMETROS Y TRANSPORTE DENTRO DE AR — permite cambiar
  // los sliders del equipo activo e iniciar/pausar/reiniciar la simulación
  // sin salir de la vista de cámara (antes solo era posible desde el panel
  // de escritorio, invisible mientras la sesión AR está activa). Lee/
  // escribe el estado real a través de la API pública de main.js
  // (window.Centrix), así que queda perfectamente sincronizado con el
  // panel de escritorio, las gráficas y el resto del simulador.
  // -----------------------------------------------------------------------
  function buildARParamsPanel() {
    const scroll = document.getElementById("arParamsScroll");
    if (!scroll || !window.Centrix) return;
    const equip = Scene3D.currentEquip;
    const groups = Centrix.paramGroups(equip);
    const allParams = groups.flatMap((g) => g.params);

    scroll.innerHTML = groups.map((group) => `
      <div class="param-group ar-param-group">
        <div class="param-group-title">${group.title}</div>
        ${group.params.map((p) => `
          <div class="param-row" style="--accent-c:${p.accent || "#E8A33D"}">
            <div class="param-row-head">
              <label for="ar-p-${p.key}">${p.label}</label>
              <span class="param-value" id="ar-pv-${p.key}">${UI.fmt(p.value, p.decimals)} <span class="unit">${p.unit || ""}</span></span>
            </div>
            <input type="range" id="ar-p-${p.key}" min="${p.min}" max="${p.max}" step="${p.step}" value="${p.value}">
          </div>
        `).join("")}
      </div>
    `).join("");

    // Un solo listener delegado (en vez de uno por slider) evita fugas de
    // memoria al reconstruir el panel cada vez que se cambia de equipo.
    scroll.oninput = (e) => {
      const input = e.target.closest("input[type=range]");
      if (!input) return;
      const key = input.id.replace("ar-p-", "");
      const value = parseFloat(input.value);
      const def = allParams.find((p) => p.key === key);
      const valEl = document.getElementById(`ar-pv-${key}`);
      if (valEl) valEl.innerHTML = `${UI.fmt(value, def ? def.decimals : 2)} <span class="unit">${def && def.unit ? def.unit : ""}</span>`;
      Centrix.setParam(equip, key, value);
    };
  }

  function toggleARParams(force) {
    const panel = document.getElementById("arParamsPanel");
    const btn = document.getElementById("arToggleParams");
    arParamsOpen = typeof force === "boolean" ? force : !arParamsOpen;
    if (panel) panel.style.display = arParamsOpen ? "flex" : "none";
    if (btn) btn.classList.toggle("active", arParamsOpen);
    if (arParamsOpen) { buildARParamsPanel(); syncARTransportUI(); }
  }

  function syncARTransportUI() {
    if (!window.Centrix) return;
    const playing = Centrix.isPlaying();
    const btnPlay = document.getElementById("arSimPlay");
    const btnPause = document.getElementById("arSimPause");
    if (btnPlay) btnPlay.classList.toggle("active", playing);
    if (btnPause) btnPause.classList.toggle("active", !playing);
    const speed = Centrix.getSpeed();
    document.querySelectorAll("#arSimSpeedGroup .speed-btn").forEach((b) => {
      b.classList.toggle("active", parseFloat(b.dataset.speed) === speed);
    });
  }

  function wireARTransport() {
    const btnPlay = document.getElementById("arSimPlay");
    const btnPause = document.getElementById("arSimPause");
    const btnReset = document.getElementById("arSimReset");
    const speedGroup = document.getElementById("arSimSpeedGroup");
    if (btnPlay) btnPlay.addEventListener("click", () => { Centrix.play(); syncARTransportUI(); });
    if (btnPause) btnPause.addEventListener("click", () => { Centrix.pause(); syncARTransportUI(); });
    if (btnReset) btnReset.addEventListener("click", () => { Centrix.reset(); });
    if (speedGroup) speedGroup.addEventListener("click", (e) => {
      const b = e.target.closest(".speed-btn");
      if (!b) return;
      Centrix.setSpeed(parseFloat(b.dataset.speed));
      syncARTransportUI();
    });
  }

  // -----------------------------------------------------------------------
  // §11. CABLEADO DE LA UI (botón de entrada + controles del overlay)
  // -----------------------------------------------------------------------
  function wireUI() {
    const btnAR = document.getElementById("btnAR");
    if (btnAR) btnAR.addEventListener("click", handleARButtonClick);

    const btnExit = document.getElementById("arExit");
    if (btnExit) btnExit.addEventListener("click", stop);

    const btnResetPos = document.getElementById("arResetPlacement");
    if (btnResetPos) btnResetPos.addEventListener("click", () => { resetPlacement(); closeOptionsMenu(); });

    const chkLabels = document.getElementById("arToggleLabels");
    if (chkLabels) chkLabels.addEventListener("click", () => {
      const active = chkLabels.classList.toggle("active");
      toggleLabels(active);
    });

    const chkTheory = document.getElementById("arToggleTheory");
    if (chkTheory) chkTheory.addEventListener("click", () => {
      const active = chkTheory.classList.toggle("active");
      toggleTheory(active);
      closeOptionsMenu(); // "Explorar componentes" es la opción que más se usa justo después de abrir el menú; se cierra para dejar la vista despejada para tocar el modelo
    });

    // Botón "Opciones" (⋮) — agrupa Etiquetas + Explorar componentes fuera
    // de la vista por defecto. Se cierra al tocar fuera del menú, para no
    // dejarlo flotando sobre el visor.
    const btnOptions = document.getElementById("arToggleOptions");
    const optionsMenu = document.getElementById("arOptionsMenu");
    if (btnOptions && optionsMenu) {
      btnOptions.addEventListener("click", (e) => {
        e.stopPropagation();
        const willOpen = optionsMenu.style.display === "none";
        optionsMenu.style.display = willOpen ? "flex" : "none";
        btnOptions.setAttribute("aria-expanded", String(willOpen));
        btnOptions.classList.toggle("active", willOpen);
      });
      document.addEventListener("click", (e) => {
        if (optionsMenu.style.display === "none") return;
        if (e.target === btnOptions || btnOptions.contains(e.target)) return;
        if (optionsMenu.contains(e.target)) return;
        closeOptionsMenu();
      });
    }

    // Menú "Seleccionar equipo" dentro del overlay AR (opcional en el DOM;
    // si no existe simplemente no se cablea nada).
    document.querySelectorAll("[data-ar-equip]").forEach((btn) => {
      btn.addEventListener("click", () => { switchEquip(btn.dataset.arEquip); closeOptionsMenu(); });
    });

    const btnParamsToggle = document.getElementById("arToggleParams");
    if (btnParamsToggle) btnParamsToggle.addEventListener("click", () => toggleARParams());

    wireARTransport();
  }

  function init() {
    wireUI();
    checkSupport();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  return { start, stop, switchEquip };
})();
