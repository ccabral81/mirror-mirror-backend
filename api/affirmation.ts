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

  const OPENER_BANK = {
  morning: [
    "As the day begins, choose a single clear priority.",
    "This morning, keep your pace calm and deliberate.",
    "Before you start, take one steady breath and set direction.",
    "Open the day with one small, clean win.",
    "Begin with clarity, not urgency.",
  ],
  afternoon: [
    "Midday is a chance to tighten focus and simplify.",
    "Return to the one task that moves things forward.",
    "Keep your attention clean and your next step obvious.",
    "Let the middle of the day be steady, not rushed.",
    "Choose progress over perfection and move once.",
  ],

  evening: [
    "Tonight, you can set things down without losing momentum.",
    "Let the day end cleanly, even if everything isn’t finished.",
    "Choose a quiet ending, then step away on purpose.",
    "Close one open loop, and let the rest wait with dignity.",
    "Release the need to solve everything before rest.",
    "Give your mind a clear stopping point.",
    "Make peace with what was enough today.",
    "Let completion be gentle, not perfect.",
    "Put a soft boundary around work and let it end there.",
    "Allow your attention to loosen its grip.",
    "Return to simplicity and let the noise fade.",
    "Let your shoulders drop and your jaw unclench.",
    "Offer yourself a calm finish line.",
    "End the day with one small act of closure.",
    "Let the unfinished remain unfinished for now.",
    "Tonight, choose ease over extra effort.",
    "Mark the day as complete in your own way.",
    "Let the pace slow without guilt.",
    "Step out of problem-solving mode.",
    "Allow rest to be the next decision.",
    "Give your body permission to soften.",
    "Let your thoughts come to a natural pause.",
    "Choose a quiet reset for tomorrow.",
    "Let the day close with clarity, not pressure.",
    "Leave space for sleep by clearing one small thing.",
    "Set down the mental checklist for now.",
    "Allow the mind to settle into a simpler focus.",
    "Finish with gratitude for effort, not outcomes.",
    "Let what happened be what happened, and release the rest.",
    "Turn down the internal volume and come back to the room.",
    "Let the last hour be lighter than the day.",
    "Choose stillness as a form of strength.",
    "Let your next step be to stop.",
    "End the evening with a clean, quiet exhale.",
    "Let your attention return to the present moment.",
    "Tonight, you don’t need to prove anything.",
    "Let yourself be off-duty.",
    "Close the day the way you’d close a door: gently and fully.",
    "Allow the day to conclude without replaying it.",
    "Let your mind unclutter as the night arrives.",
    "Choose a softer focus and let it be enough.",
    "Release urgency; there’s nothing to chase right now.",
    "Let rest be intentional, not accidental.",
    "Let your body know it’s safe to slow down.",
    "Make room for sleep by letting go of one worry.",
    "Let the day end without negotiation.",
    "Set your intention for rest, then follow it.",
    "Let your breathing guide you toward a quieter pace.",
    "Choose a calm landing after a full day.",
    "Let the day finish in one piece, even if it wasn’t perfect."
  ],

  bedtime: [
    "Let the day come to an end on purpose.",
    "Close the day with a clear stopping point.",
    "Let what is unfinished wait until tomorrow.",
    "End the day without adding anything more to it.",
    "Allow the day to be complete as it is.",
    "Mark the end of today and set it down.",
    "Choose a point to stop, and let it be enough.",
    "Let the night begin and the day conclude.",
    "Bring the day to a quiet close.",
    "Let the last thing you do be to stop.",
  ],

  } as const;

  function pick<T>(arr: readonly T[]) {
  return arr[Math.floor(Math.random() * arr.length)];
  }

const openerRaw = pickNonRepeatingOpener(mode, ip, [...OPENER_BANK[mode]], 20);

  type Intent = "orient" | "act" | "close" | "rest";

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
  "hearing you"
];

const intentTextEn =
  intent === "orient"
    ? "Focus on clarifying where the person is and what matters right now."
    : intent === "act"
    ? "Focus on recommending one clean, realistic next step."
    : "Focus on choosing a stopping point and ending the day on purpose, without urgency or extreme language.";

const intentTextEs =
  intent === "orient"
    ? "Enfócate en aclarar dónde está la persona y qué importa ahora."
    : intent === "act"
    ? "Enfócate en recomendar un siguiente paso claro y realista."
    : "Enfócate en ayudar a cerrar el día o cerrar un pendiente de forma deliberada.";

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
  "NO narres lo que el usuario está haciendo en este momento.",
  "NO inventes escenas físicas concretas: nada de salas, habitaciones, mesas, escritorios, sofás, oficinas, documentos, correos electrónicos, pantallas ni dispositivos.",
  "NO hables de 'entorno', 'espacio','lugar', 'momento presente', 'intimidad con el momento' ni 'elección consciente'.",
  "NO uses verbos en modo imperativo como 'actúa', 'opta', 'elige', 'tómate un momento', 'debes', 'deberías'.",
  "NO uses lenguaje terapéutico, elogios, hype ni clichés.",
  "No asumas que el usuario esta trabajando o ejecutando tareas",
  "NO menciones 'la situación', 'esta situación', 'hechos', 'información', 'evaluación' o 'prioridad'.",
  "NO uses órdenes extremas o absolutas como 'inmediatamente', 'completamente' o 'totalmente'.",
  "NO menciones computadoras, teléfonos, aplicaciones ni acciones de software como cerrar aplicaciones o apagar dispositivos.",
  "Sin metáforas, sin imaginacion, sin instrucciones de respiración.",
  "Cada oración debe ser simple y declarativa.",
  "Sin emojis. Sin signos de exclamación."
].join(" ");


const bannedPhrasesEs = [
    // Lenguaje de app calm / meditación
  "respira",
  "respiración",
  "exhala",
  "inhala",
  "relájate",
  "relaja",
  "suaviza",
  "afloja",
  "déjalo ir",
  "soltar",
  "sistema nervioso",
  "conciencia tranquila",
  "paso a paso",

  // Narración de estado / situación
  "esta situación",
  "la situación",
  "requiere atención",
  "requiere tu atención",
  "requiere clara atención",
  "has identificado",
  "estás identificando",
  "te encuentras en un punto",
  "estás aquí en este momento",
  "se está recopilando información",
  "evaluación de hechos",
  "evaluación de",
  "prioridad actual",
  "la prioridad actual",
  "demandas específicas",
  "proporcionar información clara",
  "el enfoque está en",
  "el enfoque es",
  "deben tomarse decisiones",
  "decisiones deben tomarse",
  "las acciones que tomes ahora",
  "permítete",
  "tomaste las",
  "decisiones necesarias",
  "terminar este ciclo",
  "ciclo ahora",
  "intención clara",
  "poner un límite",
  "restaurar tu energía",
  "tómate un momento",
  "en cuestión",
  "transitar al descanso",
  "dirige la atención por completo",
  "siguiente fase",
  "ciclo actual",
  "avanzando hacia lo que sigue",
  "prepárate para empezar de nuevo mañana",
  "enfoca hacia el descanso",

  // Trabajo / entorno / lenguaje corporativo
  "trabajo",
  "espacio de trabajo",
  "relacionado con el trabajo",
  "equipo",
  "sistemas",
  "herramientas",
  "materiales",
  "documentos",
  "notificaciones",
  "conexiones",
  "apagar",
  "apagar el trabajo",
  "preparar el entorno",
  "preparar el espacio",
  "alejarte de responsabilidades",
  "desconectando",
  "tiempo muerto",
  "operaciones",
  "cerrar operaciones",
  "actividades no productivas",
  "compromisos activos",
  "actividad en curso",
  "esfuerzos actuales",

  // Absolutos / comandos extremos
  "inmediatamente",
  "descanso completo",
  "estado de descanso",
  "desconéctate por completo",

  // Cierres suaves / poéticos
  "deja que tus pensamientos",
  "déjate",
  "pon un límite suave",
  "baja el volumen interno",
  "línea de meta",
  "con dignidad",
  "con gracia",
  "con facilidad",
  "cierre suave",
  "final tranquilo",
  "liberar el resto",

  // Coaching somático
  "relaja los",
  "relaja tus",
  "suelta la tensión",
  "mandíbula",
  "hombros",

  // Escenas físicas inventadas
  "cierra carpetas",
  "limpia tu espacio de trabajo",
  "apaga dispositivos",
  "habitacion con",
  "dispositivos que necesitan",
  "teclado",
  "pantalla",
  "escritorio",

  // Meta / hablar como asistente
  "como asistente",
  "como una ia",
  "como una inteligencia artificial",
  "te estoy escuchando",
  "escuchándote",
  "oyéndote",
  "escucho",
  "hablando..."
];

const bannedLineEs = `Avoid these phrases entirely: ${bannedPhrasesEs
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
      temperature: 1.1
    });

   let text = String(r.output_text ?? "").trim();

    if (!text) {
      return res.status(502).json({ error: "Empty response from model" });
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

