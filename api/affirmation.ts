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

type DayMode = "morning" | "afternoon" | "evening";
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
  if (x === "afternoon") return "afternoon";
  if (x === "evening") return "evening";
  return "morning";
}

function clampLanguage(x: unknown): "en" | "es" {
  return x === "es" ? "es" : "en";
}

function bool(x: unknown): boolean {
  return x === true;
}

type Intent = "orient" | "act" | "close";

function modeToIntent(mode: DayMode): Intent {
  if (mode === "afternoon") return "orient";
  if (mode === "evening") return "close";
  return "act";
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



  } as const;

  function pick<T>(arr: readonly T[]) {
  return arr[Math.floor(Math.random() * arr.length)];
  }

  const openerRaw = pickNonRepeatingOpener(mode, ip, [...OPENER_BANK[mode]], 20);

  const firstSentence = includeName ? `${name}, ${openerRaw.charAt(0).toLowerCase()}${openerRaw.slice(1)}` : openerRaw;

const intent = modeToIntent(mode);

const nameRule = includeName
  ? `Use the user's name "${name}" once in the first sentence, in a natural way.`
  : `Do not use the user's name in this statement.`;

  const nameExtraRule = includeName
  ? "Use the name at most once total. Never repeat the name. If the name does not fit naturally, omit it."
  : "";


const bannedPhrasesEn = [
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
  "provide clear information"
];

const bannedLineEn = `Avoid these phrases entirely: ${bannedPhrasesEn
  .map((p) => `"${p}"`)
  .join(", ")}.`;

 
const intentTextEn =
  intent === "orient"
    ? "Focus on clarifying where the person is and what matters right now."
    : intent === "act"
    ? "Focus on recommending one clean, realistic next step."
    : "Focus on helping the person end the day or close a loop on purpose.";

// Spanish versions (simple for now)
const bannedLineEs = `Evita completamente expresiones como: respirar, relájate, suavemente, soltar, exhalar, sistema nervioso.`;

const intentTextEs =
  intent === "orient"
    ? "Enfócate en aclarar dónde está la persona y qué importa ahora."
    : intent === "act"
    ? "Enfócate en recomendar un siguiente paso claro y realista."
    : "Enfócate en ayudar a cerrar el día o cerrar un pendiente de forma deliberada.";

const baseRulesEn = [
  `Write a short mirror statement in the "Calm Operator" voice.`,
  `Write exactly ${sentences} short sentence(s).`,
  "Be practical and composed.",
  "Each sentence must be short and direct.",
  "Prefer action and decision over emotion or description.",
  "Do NOT describe the user's mental state.",
  "Do NOT write sentences that begin with 'You are', 'You're', or 'You were'.",
  "Do NOT mention 'the situation', 'this situation', 'facts', 'information', 'assessment', or 'priority'.",
  "No status narration. No commentary about what the user is doing or feeling.",
  "Avoid therapy language, praise, hype, or clichés.",
  "No metaphors, no imagery, no breathing instructions.",
  "Each sentence must be plain and declarative.",
  "No emojis. No exclamation marks."
].join(" ");


const baseRulesEs = [
  `Escribe una declaración breve en la voz "Calm Operator".`,
  `Escribe exactamente ${sentences} oración(es) cortas.`,
  "Sé práctico y sereno.",
  "Prefiere acción y decisión sobre emoción o descripción.",
  "Evita lenguaje terapéutico, elogios, exageraciones o clichés.",
  "Sin metáforas, sin imágenes, sin instrucciones de respiración.",
  "Cada oración debe ser simple y declarativa.",
  "Sin emojis. Sin signos de exclamación."
].join(" ");

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

    // Ensure the fixed opener is the first sentence
    // (belt + suspenders in case the model omits or alters it)
    if (!text.startsWith(firstSentence)) {
      text = `${firstSentence} ${text}`.trim();
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

