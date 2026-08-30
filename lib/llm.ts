import { z } from "zod";

// This module ONLY explains discrepancies the deterministic engine (lib/reconcile.ts)
// has already found. It never decides whether records match — it receives the
// verdict as input and produces plain-language output.
//
// Uses Google Gemini (free tier, no credit card required) via a direct REST
// call, so no extra SDK dependency is needed.

const ExplanationSchema = z.object({
  summary: z.string(),        // one or two sentences, plain language
  likely_cause: z.string(),   // what probably happened
  recommended_action: z.string(), // what someone should do next
});

export type Explanation = z.infer<typeof ExplanationSchema>;

const GEMINI_MODEL = "gemini-3.5-flash-lite";
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

export async function explainDiscrepancies(
  discrepancies: Array<{
    type: string;
    orderRef: string | null;
    paymentRef: string | null;
    amountExpected: number | null;
    amountActual: number | null;
    amountAtRisk: number;
    detail: string;
  }>
): Promise<Explanation> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new LlmConfigError("GEMINI_API_KEY is not set");
  }

  const prompt = `You are helping a finance operations person understand order/payment reconciliation discrepancies from an online store. You are given a deterministic system's ALREADY-DECIDED findings below. Do not re-evaluate or second-guess whether these are real matches — only explain them in plain language.

Discrepancies (JSON):
${JSON.stringify(discrepancies, null, 2)}

Respond with a JSON object with exactly these keys:
- "summary": one or two plain-language sentences describing what is going on across these discrepancies
- "likely_cause": the most probable operational explanation
- "recommended_action": a concrete next step someone should take`;

  // Temperature 0.2: this is an explanatory/summarization task over data that
  // is already fixed and deterministic. We want low variance so the same
  // discrepancy set produces a materially consistent explanation each time,
  // while leaving a little room for natural phrasing (0 felt overly terse
  // and repetitive in testing). This is not a creative-writing task, so we
  // deliberately stay well below the higher-temperature range.
  const res = await fetch(`${GEMINI_URL}?key=${apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 400,
        responseMimeType: "application/json",
        responseSchema: {
          type: "object",
          properties: {
            summary: { type: "string" },
            likely_cause: { type: "string" },
            recommended_action: { type: "string" },
          },
          required: ["summary", "likely_cause", "recommended_action"],
        },
      },
    }),
  });

  if (!res.ok) {
    throw new LlmFormatError(`Gemini API returned status ${res.status}`);
  }

  const data = await res.json().catch(() => null);
  const raw: string | undefined = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!raw) {
    throw new LlmFormatError("Gemini response had no text content");
  }

  // Defensive parsing: even with responseSchema requested, backend code
  // must never trust model output blindly.
  let parsed: unknown;
  try {
    const cleaned = raw.trim().replace(/^```json\s*/i, "").replace(/```$/, "");
    parsed = JSON.parse(cleaned);
  } catch {
    throw new LlmFormatError("Model did not return valid JSON");
  }

  const result = ExplanationSchema.safeParse(parsed);
  if (!result.success) {
    throw new LlmFormatError("Model JSON did not match expected shape");
  }
  return result.data;
}

export class LlmFormatError extends Error {}
export class LlmConfigError extends Error {}
