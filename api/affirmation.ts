import type { VercelRequest, VercelResponse } from "@vercel/node";

const OPENER_HISTORY = new Map<string, { items: string[]; resetAt: number }>();

function pickNonRepeatingOpener(mode: DayMode, ip: string, bank: string[], keepLast = 20) {
  const now = Date.now();
  const key = `${ip}:${mode}`;
  const cur = OPENER_HISTORY.get(key);

  if (!cur || now > cur.resetAt) {
    OPENER_HISTORY.set(key, { items: [], resetAt: now + 24 * 60 * 60 * 1000 });
  }

  const state = OPENER_HISTORY.get(key)!;

  // Try a few times to avoid recent openers
  for (let i = 0; i < 12; i++) {
    const candidate = bank[Math.floor(Math.random() * bank.length)];
    if (!state.items.includes(candidate)) {
      state.items.unshift(candidate);
      state.items = state.items.slice(0, keepLast);
      OPENER_HISTORY.set(key, state);
      return candidate;
    }
  }

  // If bank is too small, accept
  const fallback = bank[Math.floor(Math.random() * bank.length)];
  state.items.unshift(fallback);
  state.items = state.items.slice(0, keepLast);
  OPENER_HISTORY.set(key, state);
  return fallback;
}

/**
 * Mirror, Mirror — AI Affirmation endpoint (Vercel Function)
 * POST /api/affirmation
 *
 * Notes:
 * - Uses Node/Vercel req/res (NOT Fetch Request/Response)
 * - Loads OpenAI SDK via dynamic import to avoid ESM/CJS runtime crashes
 */

type DayMode = "morning" | "afternoon" | "evening" | "bedtime";
type Tone = "luxury-calm" | "direct-calm";

type AffirmationRequest = {
  name?: string;
  sentences?: 2 | 3;
  tone?: Tone;
  mode?: DayMode;
  language?: "en" | "es";
  tier?: "free" | "premium";
  mustIncludeName?: boolean;
};

type AffirmationResult = {
  text: string;
  meta: {
    source: "remote";
    remaining?: number;
    createdAtISO: string;
  };
};

// --------------------
// Best-effort rate limit (in-memory)
// NOTE: Serverless instances can scale, so this is "best-effort" only.
// For real production, move to Upstash/Redis.
// --------------------
const bucket = new Map<string, { count: number; resetAt: number }>();

function rateLimitOk(key: string, limit: number, windowMs: number) {
  const now = Date.now();
  const cur = bucket.get(key);

  if (!cur || now > cur.resetAt) {
    bucket.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true, remaining: limit - 1 };
  }

  if (cur.count >= limit) return { ok: false, remaining: 0 };

  cur.count += 1;
  bucket.set(key, cur);
  return { ok: true, remaining: limit - cur.count };
}

// --------------------
// Input normalization helpers
// --------------------
function safeName(x: unknown): string {
  const n = typeof x === "string" ? x.trim() : "";
  return (n || "Friend").slice(0, 40);
}

function clampSentences(x: unknown): 2 | 3 {
  return x === 2 ? 2 : 3;
}

function clampTone(x: unknown): Tone {
  return x === "direct-calm" ? "direct-calm" : "luxury-calm";
}

function clampMode(x: unknown): DayMode {
  if (x === "morning") return "morning";
  if (x === "afternoon") return "afternoon";
  if (x === "evening") return "evening";
  if (x === "bedtime") return "bedtime";
  return "morning"; // fallback
}


function clampLanguage(x: unknown): "en" | "es" {
  return x === "es" ? "es" : "en";
}

function bool(x: unknown): boolean {
  return x === true;
}

// --------------------
// OpenAI client (dynamic import to avoid ESM/CJS issues)
// --------------------
let OpenAIClass: any = null;

async function getOpenAIClient(apiKey: string) {
  if (!OpenAIClass) {
    const mod = await import("openai");
    OpenAIClass = mod.default;
  }
  return new OpenAIClass({ apiKey });
}

// --------------------
// Handler
// --------------------
export default async function handler(req: VercelRequest, res: VercelResponse) {
  // CORS (helps if you test from a browser; harmless for mobile)
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "Server missing OPENAI_API_KEY" });
  }

  // IP (best-effort)
  const xf = req.headers["x-forwarded-for"];
  const xr = req.headers["x-real-ip"];
  const ip =
    (Array.isArray(xf) ? xf[0] : xf)?.split(",")[0]?.trim() ||
    (Array.isArray(xr) ? xr[0] : xr) ||
    "unknown";

  // Rate limit: 30 requests / 10 minutes per IP (MVP)
  const rl = rateLimitOk(ip, 30, 10 * 60 * 1000);
  if (!rl.ok) {
    return res.status(429).json({ error: "Rate limit exceeded" });
  }

  // Body parsing (VercelRequest may give object or string)
  let body: AffirmationRequest = {};
  try {
    body =
      typeof req.body === "string"
        ? (JSON.parse(req.body) as AffirmationRequest)
        : ((req.body ?? {}) as AffirmationRequest);
  } catch {
    return res.status(400).json({ error: "Invalid JSON body" });
  }

  const name = safeName(body.name);
  const sentences = clampSentences(body.sentences);
  const tone = clampTone(body.tone);
  const mode = clampMode(body.mode);
  const language = clampLanguage(body.language);
  const mustIncludeName = bool(body.mustIncludeName);

  // Name inclusion policy (35% unless mustIncludeName)
  const includeName = mustIncludeName ? true : Math.random() < 0.35;

  //testing this line for

  type Intent = "orient" | "act" | "close" | "rest";

  const OPENER_BANK_EN: Record<DayMode, readonly string[]> = {
    morning: [
      "The way you start the day already hints at your standard.",
      "You begin the day more composed than you usually admit.",
      "Early in the day, your clarity is louder than the noise around you.",
      "You know how to walk into the morning without rushing your mind.",
      "The day bends more to your pace than you realize.",
    ],

    afternoon: [
      "Midday is where you quietly return to what actually matters.",
      "You know how to pull your attention back from distraction without drama.",
      "The middle of the day shows how you handle pressure without performing for anyone.",
      "You are at your best when you give one thing the full weight of your focus.",
      "You have a way of simplifying the chaos other people treat as normal.",
    ],

    evening: [
      "The way you close the day says more about you than how it started.",
      "You know how to stop for the day without losing your direction.",
      "Even when the day stays unfinished, your standard stays intact.",
      "You draw a line under the day in a way that still respects your effort.",
      "The day can end while your sense of who you are stays steady.",
      "Your evenings carry a quiet authority, not a list of apologies.",
      "You remain sure of your path even on imperfect days.",
      "How you step out of the day is part of your discipline.",
    ],

    bedtime: [
      "You decide where today ends; the clock doesn’t.",
      "You know how to call a day finished, even when it wasn’t simple.",
      "The day can stop here without reducing your momentum.",
      "You have the habit of closing days on your own terms.",
      "Marking the end of today is one of your quiet forms of control.",
      "This is a point where you can say that today was enough.",
      "You don’t need to replay the day to prove it mattered.",
      "Ending today cleanly is part of how you protect your energy.",
    ],
  } as const;

  // 🔹 Mirror, Mirror ES openers – same intent, Spanish identity tone
  const OPENER_BANK_ES: Record<DayMode, readonly string[]> = {
    morning: [
      "La forma en que empiezas el día ya revela tu estándar.",
      "Comienzas el día más compuesto de lo que sueles admitir.",
      "A primera hora, tu claridad suena más fuerte que el ruido alrededor.",
      "Sabes entrar en la mañana sin acelerar tu mente.",
      "El día se ajusta más a tu ritmo de lo que crees.",
    ],

    afternoon: [
      "A mitad del día vuelves en silencio a lo que realmente importa.",
      "Sabes recuperar la atención sin necesidad de drama.",
      "El centro del día muestra cómo manejas la presión sin actuar para el público.",
      "Das tu mejor resultado cuando le das todo tu enfoque a una sola cosa.",
      "Tienes una manera de simplificar el caos que otros aceptan como normal.",
    ],

    evening: [
      "La forma en que cierras el día dice más de ti que cómo lo empezaste.",
      "Sabes detenerte sin perder la dirección.",
      "Aunque el día quede incompleto, tu estándar sigue intacto.",
      "Trazas una línea al final del día sin faltar al respeto a tu propio esfuerzo.",
      "El día puede terminar mientras tu sentido de quién eres se mantiene firme.",
      "Tus noches llevan una autoridad silenciosa, no una lista de disculpas.",
      "Sigues seguro de tu rumbo incluso en días imperfectos.",
      "La manera en que sales del día también forma parte de tu disciplina.",
    ],

    bedtime: [
      "Eres tú quien decide dónde termina hoy, no el reloj.",
      "Sabes dar por terminado el día incluso cuando no fue sencillo.",
      "El día puede detenerse aquí sin reducir tu impulso.",
      "Tienes la costumbre de cerrar el día en tus propios términos.",
      "Marcar el final de hoy es una de tus formas silenciosas de control.",
      "Este es un punto en el que puedes decir que hoy fue suficiente.",
      "No necesitas repetir el día en tu mente para probar que importó.",
      "Cerrar hoy con claridad también es parte de cómo proteges tu energía.",
    ],
  } as const;

  // Simple pick helper (unchanged)
  function pick<T>(arr: readonly T[]) {
    return arr[Math.floor(Math.random() * arr.length)];
  }

  // If you already have pickNonRepeatingOpener, reuse it.
  // Here’s how to wire language + mode into it:
  function getOpenerRaw(
    mode: DayMode,
    ip: string,
    language: "en" | "es",
    pickNonRepeatingOpener: (
      mode: DayMode,
      ip: string,
      candidates: string[],
      historySize: number
    ) => string
  ) {
    const bank = language === "es" ? OPENER_BANK_ES : OPENER_BANK_EN;
    // keep your existing historySize (20)
    return pickNonRepeatingOpener(mode, ip, [...bank[mode]], 20);
  }

  // Intent mapping stays exactly as you had it
  function modeToIntent(mode: DayMode): Intent {
    switch (mode) {
      case "morning":
        return "orient";   // point direction
      case "afternoon":
        return "act";      // do the thing
      case "evening":
        return "close";    // wind down / close loops
      case "bedtime":
        return "rest";     // step away fully
      default:
        return "orient";
    }
  }


const intent = modeToIntent(mode);

const nameRule = includeName
  ? `Use the user's name "${name}" once in the first sentence, in a natural way.`
  : `Do not use the user's name in this statement.`;

const nameExtraRule = includeName
  ? "Use the name exactly once in the first sentence only. Do NOT repeat the name anywhere else, and do not invent new nicknames."
  : "";

// English banned phrases: calm-app stuff, status narration, invented scenes, fluff
const bannedPhrasesEn = [
  // Calm app language
  "breathe",
  "breath",
  "relax",
  "gentle",
  "soften",
  "let go",
  "exhale",
  "nervous system",
  "quiet awareness",
  "step by step",

  // Status / situation narration
  "this situation",
  "the situation",
  "requires attention",
  "requires your attention",
  "requires clear attention",
  "you have identified",
  "you are identifying",
  "you are at a point",
  "you are here in this moment",
  "information is being gathered",
  "assessment of facts",
  "assessment of",
  "current priority",
  "the current priority",
  "specific demands",
  "provide clear information",
  "the focus is on",
  "the focus is",
  "decisions need to be made",
  "decisions need to be",
  "actions taken now will",
  "allow yourself",
  "you made the",
  "necessary choices",
  "end this cycle",
  "cycle now",
  "clear intent",
  "set a boundary",
  "restore your energy",
  "take a moment",
  "at hand",
  "transitioning to rest",
  "turn attention fully",
  "next phase",
  "current cycle",
  "moving forward with what is next",
  "prepare to start fresh tomorrow",  // if you want less repetition of this exact line
  "focus toward rest",

  
  "work",
  "workspace",
  "work-related",
  "equipment",
  "systems",
  "tools",
  "materials",
  "documents",
  "notifications",
  "connections",
  "power down",
  "shut down work",
  "prepare the environment",
  "prepare the space",
  "step away from responsibilities",
  "disengaging",
  "downtime",

  "stop all ongoing",
  "stop all current",
  "immediately",
  "complete rest",
  "state of rest",
  "unshared period",
  "stillness",
  "disconnect completely",
  "close operations",
  "temporary data",
  "operations",
  "non-productive activities",
  "active engagements",

  "stop work",
  "close applications",
  "materials",
  "evening activities",
  "firm stopping point",
  "stop what you are doing",
  "ongoing activity",
  "current efforts",

  // Soft / poetic closers
  "let your thoughts",
  "let yourself",
  "let rest be intentional",
  "turn down the internal volume",
  "put a soft boundary",
  "finish line",
  "with dignity",
  "with grace",
  "with ease",
  "deliberate finality",
  "gentle close",
  "calm finish",
  "release the rest",

  // Somatic coaching
  "jaw unclench",
  "let your shoulders",
  "relax your",
  "release tension",

  // Invented physical scenes
  "close folders",
  "clear your workspace",
  "shut down devices",
  "room with",
  "devices that need",
  "keyboard",
  "screen",
  "desk",

  // Meta / speaking as assistant
  "speaking...",
  "as an ai",
  "assistant",
  "listening",
    "hearing you",
  "feels too much",
  "feel too much",
  "feel overwhelming",
  "overwhelming",
  "overwhelmed",
  "shield",
  "core",
  "exposure",
  "cannot be crossed",
  "builds a boundary",
  "silence becomes",
  "this moment ends here",
  "this moment is a clear point of pause",
  "the moment ends here",
  "this moment is marked by",
  "this day ends here",
  "the day ends here",
  "this day is now closed",
];

const METAPHOR_EN = [
  "shield",
  "armor",
  "wall",
  "line that cannot be crossed",
  "builds a boundary",
  "core",
  "exposure",
  "journey",
  "path",
  "refuge",
  "perimeter",
  "private edge",
  "guarded stances",
  "shape of self",
  "world narrows",
  "contracts inward",
];

const EMOTIONAL_STATE_EN = [
  "feel overwhelmed",
  "feels overwhelming",
  "feels too much",
  "feel too much",
  "too much to handle",
  "heavy to carry",
  "emotional burden",
  "beyond your comfort",
  "demands too much",
  "demand too much",
  "feels intrusive",
  "what feels intrusive",
  "when complexity grows",
  "before confusion sets in",
  "when the world demands too much",
  "when situations demand too much",
  
];

const CLOSURE_EN = [
  "this moment ends here",
  "this day ends here",
  "this moment is a clear point of pause",
  "the moment is closed",
];


const intentTextEn =
  intent === "orient"
    ? "Reflect how the person tends to orient themselves and what currently matters in their stance, not tasks."
    : intent === "act"
    ? "Reflect how the person tends to act and make decisions, without listing tasks or giving instructions."
    : "Reflect how the person relates to limits, distance, and stepping back, without saying that this specific day or moment is ending.";

const intentTextEs =
  intent === "orient"
    ? "Refleja cómo la persona suele orientarse y qué importa ahora en su postura, no en tareas."
    : intent === "act"
    ? "Refleja cómo la persona suele actuar y decidir, sin listar tareas ni dar instrucciones."
    : "Refleja cómo la persona se relaciona con los límites, la distancia y el tomar espacio, sin decir que este día o este momento se cierran.";



const baseRulesEn = [
  `You are MIRROR, MIRROR — a luxury identity-reflection system.`,
  `Write exactly ${sentences} short sentence(s).`,
  `Do NOT write more than ${sentences} sentences under any circumstance.`,
  "Each sentence must be declarative and about identity or stance, not tasks or steps.",
  "Do not ask questions.",
  "Do not give advice or instructions.",
  "Do not praise, congratulate, encourage, or reassure.",
  "Avoid therapy language (heal, trauma, processing emotions, validation).",
  "Avoid corporate or productivity wording (performance, productivity, results, goals, output, tasks).",
  "Avoid hype language (grind, hustle, push harder, no excuses).",
  "Do NOT describe the user's mental state.",
  "Do NOT narrate what the user is doing or feeling right now.",
  "Do NOT invent specific situations, apps, devices, or locations.",
  "No metaphors. No imagery. No breathing instructions.",
  "Do NOT mention facts, information, assessments, or priorities.",
  "Do NOT explain what you are doing. Return only the final statement.",
  "Do NOT use metaphors such as shields, lines, walls, roads, journeys, or stories.",
  "Do NOT describe how things 'feel' or whether something is overwhelming, heavy, or too much.",
  "Do NOT use metaphors like shields, walls, edges, perimeters, cores, or journeys.",
  "Do NOT describe how things feel (overwhelming, too much, intrusive, confusing, heavy).",
  "Do NOT narrate that 'this day' or 'this moment' is ending, closing, or stopping here.",
  "Do NOT talk about closing cycles, chapters, or stories.",
  "Sentences must be short, plain, and declarative.",
  "No emojis. No exclamation marks.",
  "Do not overuse 'You are' phrasing; vary structure naturally, but it is allowed.",
].join(' ');

const baseRulesEs = [
  `Escribe una breve declaración tipo espejo en la voz "Calm Operator".`,
  `Escribe exactamente ${sentences} oración(es) corta(s).`,
  `NO escribas más de ${sentences} oración(es) bajo ninguna circunstancia.`,
  "Sé práctico y sereno.",
  "Cada oración debe ser corta y directa.",
  "Evita hacer una lista de pequeños pasos. Combina ideas relacionadas en menos oraciones, más firmes.",
  "Prefiere postura y decisión sobre emoción o descripción.",
  "NO describas el estado mental del usuario.",
  // lenguaje de tareas / objetivos
  "NO hables de tareas, objetivos, pasos, plazos, periodos, recursos, asistencia, listas, impacto, resultados ni productividad.",
  // imperativos / instrucciones
  "NO des instrucciones ni órdenes como 'revisa', 'evalúa', 'define', 'elige', 'identifica', 'ejecuta', 'actúa', 'procede', 'mantén', 'toma nota'.",
  "NO escribas oraciones que comiencen directamente con un verbo en modo imperativo.",
  // ⬇️ NUEVO: no validación, no consuelo
  "NO tranquilices ni valides con frases como 'está bien', 'es válido', 'no hay necesidad', 'no exige respuesta inmediata', 'es suficiente'.",
  // ⬇️ NUEVO: no calma interna / silencio / metáforas de ciclo/capítulo
  "NO hables de calma interna, ruido externo, silencio interno, silencio como refugio ni cierres de 'ciclos' o 'capítulos'.",
  "NO uses lenguaje de procesamiento emocional como 'procesar lo que pasó' o 'procesar ahora'.",
  "NO narres lo que el usuario está haciendo en este momento.",
  "NO narres que 'este día' o 'este momento' terminan, se cierran o se detienen aquí.",
  "NO hables de 'ciclos', 'capítulos', 'historias' ni del 'momento' como algo que se abre o se cierra.",
  "NO inventes situaciones físicas específicas, objetos, dispositivos, habitaciones, mesas, documentos, correos electrónicos o pantallas.",
  "NO uses lenguaje terapéutico, elogios, hype ni clichés.",
  "NO hables de 'ciclos', 'capítulos', 'historias' ni del 'momento' como si fuera algo que se abre o se cierra.",
  "NO uses la primera persona ('yo', 'me', 'mi', 'conozco', 'reconozco', 'dejo') ni hables como si fueras quien está tomando la decisión.",
  "NO menciones 'la situación', 'esta situación', 'hechos', 'información', 'evaluación' o 'prioridad'.",
  "NO uses órdenes extremas o absolutas como 'inmediatamente', 'completamente' o 'totalmente'.",
  "NO menciones computadoras, teléfonos, aplicaciones ni acciones de software como cerrar aplicaciones o apagar dispositivos.",
  "NO uses lenguaje de carga emocional como 'cargar más', 'peso' o 'lastre'.",
  "Sin metáforas, sin imágenes, sin instrucciones de respiración.",
  "Cada oración debe ser simple y declarativa.",
  "Sin emojis. Sin signos de exclamación."
].join(" ");


const bannedPhrasesEs = [
  // calm / terapia / meditación
  "respira",
  "respiración",
  "exhala",
  "relájate",
  "déjalo ir",
  "momento presente",
  "intimidad con el momento",

  // tareas / objetivos / productividad
  "tarea",
  "tareas",
  "objetivo",
  "objetivos",
  "plazo",
  "plazos",
  "periodo",
  "período",
  "recurso",
  "recursos",
  "asistencia",
  "lista",
  "listado",
  "impacto",
  "resultados",
  "productividad",
  "disciplina",       // opcional si se vuelve muy coach

  // comandos típicos de coach
  "define un objetivo",
  "define un objetivo claro",
  "establece un límite de tiempo",
  "prioriza una acción concreta",
  "reserva tiempo",
  "organiza ese listado",
  "ajusta tu enfoque",
  "mantén el enfoque",
  "ejecuta esa acción",
  "completa esa tarea",
  "procede con ese paso",

  // escenas / objetos
  "sala",
  "mesa",
  "escritorio",
  "documentos",
  "correo electrónico",
  "pantalla",

   "tarea",
  "tareas",
  "objetivo",
  "objetivos",
  "paso concreto",
  "siguiente paso",
  "plazo",
  "plazos",
  "periodo",
  "período",
  "recurso",
  "recursos",
  "asistencia",
  "lista",
  "listado",
  "impacto",
  "resultados",
  "productividad",

    // validación / consuelo
  "está bien",
  "esta bien",
  "es válido",
  "es valido",
  "no hay necesidad",
  "no exige respuesta inmediata",
  "lo que has hecho hasta ahora es suficiente",
  "es suficiente",
  "fue suficiente",

  // calma / silencio / ruido
  "conservar la calma",
  "calma interna",
  "ruido externo",
  "silencio interno",
  "silencio también es una decisión",
  "el silencio es una decisión firme",

  // metáforas de ciclo / capítulo / momento
  "cerrar este ciclo",
  "ciclo",
  "cerrar el capítulo",
  "capítulo",
  "este momento termina aquí",

  // terapia / procesar
  "no hay más que procesar",
  "procesar ahora",
  "procesar lo que fue",
  "procesar lo que pasó",

  // voz del asistente en primera persona
  "reconozco tu manera de cerrar",


  // Patrones que estás viendo en tus ejemplos
  "decide qué aspecto merece atención inmediata",
  "decide qué opción puedes tomar ahora",
  "elige la opción que mejor se alinea",
  "identifica lo que sigue",
  "confirma el siguiente paso",
  "mantén el ritmo constante y controlado",
  "procede con paso firme",
  "actúa en consecuencia para avanzar",

  // Verbos en imperativo típicos del banco de frases
  "revisa la información",
  "evalúa lo que tienes delante",
  "analiza la decisión",
  "identifica qué se puede manejar",
  "decide un punto específico",
  "elige un punto claro para avanzar",
  "toma nota de lo que necesitas abordar",

    // primera persona / voz del asistente
  "reconozco tu forma de cerrar",
  "reconozco tu manera de cerrar",
  "reconozco lo que está presente",
  "dejo espacio para el siguiente instante",
  "no me comprometo más allá de esto",

  // cierres blandos / ruido / espacio (si quieres ser más estricto)
  "espacio se mantiene intacto",
  "dejas espacio",
  "se deja atrás sin ruido",
  "espacio vuelve a ser tuyo",
  "no hay más que procesar ahora", // por si se cuela de nuevo

    // cierres blandos / metáforas de ciclo / historia / momento
  "cierra este ciclo",
  "cerrar este ciclo",
  "ciclo",
  "cerrar el capítulo",
  "capítulo",
  "lo que sigue es otra historia",
  "este momento termina aquí",
  "el momento se cierra",
  "el momento se detiene aquí",
  "todo queda en pausa",

  "cargar más ahora",
  "cargar más",
  "queda registrado",
  "todo queda registrado",
  "se guarda en la memoria",


  // procesamiento / carga
  "lo que no se atiende ahora no desaparece",
  "no debe cargar más",
  "este momento termina aquí",
  "este momento se concluye aquí",
  "el momento se concluye",
  "el momento se detiene",
  "el tiempo para esto ha concluido",
  "este día termina aquí",
  "este día se cierra aquí",


];

const TASKY_VERBS_ES = [
  "revisa",
  "revisar",
  "evalúa",
  "evalua",
  "analiza",
  "identifica",
  "decide",
  "elige",
  "ejecuta",
  "ejecutar",
  "actúa",
  "actua",
  "procede",
  "mantén",
  "mantener",
  "organiza",
  "toma nota",
  "prioriza",
  "priorizar",
];

const TASKY_NOUNS_ES = [
  "tarea",
  "tareas",
  "objetivo",
  "objetivos",
  "paso",
  "pasos",
  "plazo",
  "plazos",
  "periodo",
  "período",
  "lista",
  "listado",
  "impacto",
  "resultados",
  "productividad",
];

const SOFT_VALIDATION_ES = [
  "está bien",
  "esta bien",
  "es válido",
  "es valido",
  "es suficiente",
  "fue suficiente",
];

const CALM_SILENCE_ES = [
  "conservar la calma",
  "silencio interno",
  "silencio también es una decisión",
  "el silencio es una decisión firme",
  "ruido externo",
  "todo queda en pausa",
  "el momento se detiene aquí",
  "el momento se cierra",
];

const FIRST_PERSON_ES = [
  "reconozco ",
  "reconozco tu",
  "dejo espacio",
  "no me comprometo",
];

const CYCLE_META_ES = [
  "cerrar este ciclo",
  "cierra este ciclo",
  "ciclo",
  "cerrar el capítulo",
  "capítulo",
  "otra historia",
];

const EMO_LOAD_ES = [
  "cargar más",
  "queda registrado",
  "se guarda en la memoria",
];

const CLOSURE_ES = [
  "este momento termina aquí",
  "este momento se concluye",
  "el momento se detiene aquí",
  "el tiempo para esto ha concluido",
];

function isBadEnglishOutput(text: string): boolean {
  const t = text.toLowerCase();

  // Any obvious metaphor or emotional-state narration is off-brand
  if (METAPHOR_EN.some((w) => t.includes(w))) return true;
  if (EMOTIONAL_STATE_EN.some((w) => t.includes(w))) return true;

  return false;
}


function isTaskySpanishOutput(text: string): boolean {
  const t = text.toLowerCase();
  return (
    TASKY_VERBS_ES.some((w) => t.includes(w)) ||
    TASKY_NOUNS_ES.some((w) => t.includes(w)) ||
    SOFT_VALIDATION_ES.some((w) => t.includes(w)) ||
    CALM_SILENCE_ES.some((w) => t.includes(w)) ||
    FIRST_PERSON_ES.some((w) => t.includes(w)) ||
    CYCLE_META_ES.some((w) => t.includes(w)) ||
    EMO_LOAD_ES.some((w) => t.includes(w)) ||
    CLOSURE_ES.some((w) => t.includes(w))
  );
}

const bannedLineEs = `Evita completamente expresiones como: ${bannedPhrasesEs
  .map((p) => `"${p}"`)
  .join(", ")}.`;

const bannedLineEn = `Avoid these phrases entirely: ${bannedPhrasesEn
  .map((p) => `"${p}"`)
  .join(", ")}.`;
  
const prompt =
  language === "es"
    ? [
        baseRulesEs,
        intentTextEs,
        bannedLineEs,
        nameRule,
        nameExtraRule,
        "Devuelve SOLO el texto final, sin explicaciones adicionales."
      ].join("\n\n")
    : [
        baseRulesEn,
        intentTextEn,
        bannedLineEn,
        nameRule,
        nameExtraRule,
        "Return ONLY the final text, no bullet points, no explanation."
      ].join("\n\n");

  try {
    const client = await getOpenAIClient(apiKey);

    const r = await client.responses.create({
      model: "gpt-4.1-mini",
      input: prompt,
      temperature: 0.8,
    });

       let text = String(r.output_text ?? "").trim();

    if (!text) {
      return res.status(502).json({ error: "Empty response from model" });
    }

     // 🔁 1) Spanish: retry once if it sounds like tasks/coach/etc.
    if (language === "es" && typeof isTaskySpanishOutput === "function" && isTaskySpanishOutput(text)) {
      try {
        const r2 = await client.responses.create({
          model: "gpt-4.1-mini",
          input: prompt,
          temperature: 0.7, // slightly lower for regeneration
        });
        const alt = String(r2.output_text ?? "").trim();
        if (alt && !isTaskySpanishOutput(alt)) {
          text = alt;
        }
      } catch (e) {
        console.warn("Spanish regen failed, keeping original text");
      }
    }

    // 🔁 2) English: retry once if it has metaphors or emotional-state narration
    if (language === "en" && isBadEnglishOutput(text)) {
      try {
        const r2 = await client.responses.create({
          model: "gpt-4.1-mini",
          input: prompt,
          temperature: 0.7, // lower temp to hug the rules tighter
        });
        const alt = String(r2.output_text ?? "").trim();
        if (alt && !isBadEnglishOutput(alt)) {
          text = alt;
        }
      } catch (e) {
        console.warn("English regen failed, keeping original text");
      }
    }

    if (!text) {
      return res.status(502).json({ error: "Empty response after filtering" });
    }

    const result: AffirmationResult = {
      text,
      meta: {
        source: "remote",
        remaining: rl.remaining,
        createdAtISO: new Date().toISOString(),
      },
    };

    return res.status(200).json(result);

  } catch (err: any) {
    // Helpful logging for Vercel function logs (avoid printing secrets)
    console.error("AI invocation failed:", err?.message ?? err);
    return res.status(502).json({ error: "Upstream AI error" });
  }
}

