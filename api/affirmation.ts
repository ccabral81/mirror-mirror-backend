import type { VercelRequest, VercelResponse } from "@vercel/node";

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

function modeIntent(mode: DayMode) {
  if (mode === "morning") return "orientation and gentle momentum for the day ahead";
  if (mode === "afternoon") return "focus, execution, and calm momentum";
  return "closure, reflection, and nervous-system calm";
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
    "Let the day soften at the edges and come to a close.",
    "Set down what you can’t finish tonight with quiet confidence.",
    "Give yourself permission to end the day gently.",
    "Close the loop on one thing, then release the rest.",
    "Let your nervous system settle; you’ve done enough for today.",
  ],
  } as const;

  function pick<T>(arr: readonly T[]) {
  return arr[Math.floor(Math.random() * arr.length)];
  }

  const opener = pick(OPENER_BANK[mode]);
  const firstSentence = includeName ? `${name}, ${opener.charAt(0).toLowerCase()}${opener.slice(1)}` : opener;

  const openerBan = "Do not start the first sentence with 'Today', 'You', 'This', or the user's name unless required. Avoid repeating any opener pattern.";

  const openerRulesEn = [
    "Vary the first word; do not start with 'Today' or 'You' every time.",
    "Do not reuse the same opening structure from prior requests.",
    "Prefer openers like: 'This morning', 'In this moment', 'Right now', 'As you begin', 'With a steady breath', 'Quietly', 'Gently', 'Step by step'."
  ].join(" ");

  const style =
    tone === "direct-calm"
      ? "direct, calm, action-oriented, no hype"
      : "luxury, calm, grounded, elegant, no hype";

  const intent = modeIntent(mode);

  const nameRule = includeName
    ? "Include the user's name in the FIRST sentence."
    : "Avoid using the user's name unless it fits naturally; prefer no name.";

  const constraints = [
    `Write exactly ${sentences} sentences.`,
    "No emojis.",
    "No exclamation marks.",
    "No clichés (e.g., 'you got this', 'believe in yourself').",
    "No exaggerated praise or grand claims.",
    "Keep it practical and calming.",
  ].join(" ");

  const remaining = sentences === 2 ? 1 : 2;

  const bannedPhrases = [
    "with a steady breath",
    "gently",
    "step by step",
    "quiet awareness",
    "reflection offers clarity",
    "measured sense of calm",
    "thoughtful closure",
    "let each exhale",
    "grounding your intentions",
  ];

  const banLine = `Avoid these phrases entirely: ${bannedPhrases.map(p => `"${p}"`).join(", ")}.`;

  const structureChoices = [
    "Structure A: practical action → calming reframe → close.",
    "Structure B: body cue → focus cue → close.",
    "Structure C: simplify → commit → release.",
    "Structure D: acknowledge → choose → settle."
  ];
  const structure = pick(structureChoices);

  const prompt =
    language === "es"
      ? `Escribe exactamente ${remaining} oración(es) para completar una afirmación. La primera oración ya está fijada y NO puedes cambiarla:\n"${firstSentence}"\n\n${structure}\n${banLine}\nSin emojis. Sin signos de exclamación. Sin clichés. Manténlo práctico y sereno. Devuelve SOLO el texto final con ${sentences} oraciones.`
      : `Write exactly ${remaining} sentence(s) to complete an affirmation. The first sentence is fixed and you MUST NOT change it:\n"${firstSentence}"\n\n${structure}\n${banLine}\nNo emojis. No exclamation marks. No clichés. Keep it practical and calming. Return ONLY the final text with exactly ${sentences} sentences.`;


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

