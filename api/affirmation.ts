// --- Minimal types (keep aligned with app) ---
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

let OpenAiClass: any = null;

async function getOpenAIClient(apiKey: string) {
  if (!OpenAiClass){
    const mod = await import("openai");
    OpenAiClass = mod.default;
  }
  return new OpenAiClass({apiKey});
}

// --- Tiny in-memory rate limit (good enough for MVP) ---
// NOTE: serverless instances can scale, so this is "best-effort".
// For production, move to Upstash/Redis, etc.
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

function safeName(x: unknown): string {
  const n = typeof x === "string" ? x.trim() : "";
  if (!n) return "Friend";
  return n.slice(0, 40);
}

function mustIncludeName(x: unknown): boolean {
  return x === true;
}

function modeIntent(mode: DayMode) {
  if (mode === "morning") return "orientation and gentle momentum for the day ahead";
  if (mode === "afternoon") return "focus, execution, and calm momentum";
  return "closure, reflection, and nervous-system calm";
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return new Response("Server missing OPENAI_API_KEY", { status: 500 });
  }

  // Best-effort rate limiting by IP (MVP)
  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "unknown";

  // e.g. 30 requests / 10 minutes per IP for MVP
  const rl = rateLimitOk(ip, 30, 10 * 60 * 1000);
  if (!rl.ok) {
    return new Response(
      JSON.stringify({ error: "Rate limit exceeded" }),
      { status: 429, headers: { "content-type": "application/json" } }
    );
  }

  let body: AffirmationRequest;
  try {
    body = (await req.json()) as AffirmationRequest;
  } catch {
    return new Response(
      JSON.stringify({ error: "Invalid JSON" }),
      { status: 400, headers: { "content-type": "application/json" } }
    );
  }

  const name = safeName(body.name);
  const sentences = clampSentences(body.sentences);
  const tone = clampTone(body.tone);
  const mode = clampMode(body.mode);
  const language = clampLanguage(body.language);
  const includeName = mustIncludeName(body.mustIncludeName) ? true : Math.random() < 0.35;

  // Build a tight prompt (no fluff, no exaggerated praise)
  const style =
    tone === "direct-calm"
      ? "direct, calm, action-oriented, no hype"
      : "luxury, calm, grounded, elegant, no hype";

  const intent = modeIntent(mode);

  const nameRule = includeName
    ? "Include the user's name in the FIRST sentence."
    : "Do NOT include the user's name unless it naturally fits; prefer no name.";

  const constraints = [
    `Write exactly ${sentences} sentences.`,
    "No emojis.",
    "No exclamation marks.",
    "No clichés (e.g., 'you got this', 'believe in yourself').",
    "No exaggerated praise or grand claims.",
    "Keep it practical and calming.",
  ].join(" ");

  const userPrompt =
    language === "es"
      ? `Genera una afirmación breve para el usuario. Nombre: ${name}. Estilo: ${style}. Intención del momento del día: ${intent}. ${nameRule} ${constraints}`
      : `Generate a brief affirmation for the user. Name: ${name}. Style: ${style}. Day-mode intent: ${intent}. ${nameRule} ${constraints}`;

  const client = new OpenAI({ apiKey });

  // Responses API (recommended for new work)
  const r = await client.responses.create({
    model: "gpt-4.1-mini",
    input: userPrompt,
  });

  // Extract text safely
  const text =
    (r.output_text ?? "").trim();

  if (!text) {
    return new Response(
      JSON.stringify({ error: "Empty response" }),
      { status: 502, headers: { "content-type": "application/json" } }
    );
  }

  return new Response(
    JSON.stringify({
      text,
      meta: {
        source: "remote",
        remaining: rl.remaining,
        createdAtISO: new Date().toISOString(),
      },
    }),
    {
      status: 200,
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
      },
    }
  );
}
