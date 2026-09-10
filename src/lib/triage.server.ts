import { NoObjectGeneratedError, Output, streamText } from "ai";
import { z } from "zod";
import { getChatModel } from "./ai-gateway.server";
import type { ChatTurn, ProviderReview, ReviewInsights, TriageTurn } from "./types";

/**
 * Kept deliberately permissive: the model regularly omits or nulls fields, and a
 * strict schema turns that into a hard "response did not match schema" failure.
 * Everything is normalised into the strict app shape by `normaliseTurn` below.
 */
const looseAssessmentSchema = z.object({
  summary: z.string().nullish(),
  collected: z
    .object({
      symptoms: z.string().nullish(),
      duration: z.string().nullish(),
      severity: z.string().nullish(),
      related_symptoms: z.string().nullish(),
    })
    .nullish(),
  possible_conditions: z
    .array(
      z.object({
        name: z.string().nullish(),
        explanation: z.string().nullish(),
        why_relevant: z.string().nullish(),
      }),
    )
    .nullish(),
  recommended_specialty: z.string().nullish(),
  urgency: z.string().nullish(),
  urgency_reason: z.string().nullish(),
  red_flags: z.array(z.string()).nullish(),
  safety_message: z.string().nullish(),
});

const turnSchema = z.object({
  reply: z.string().nullish(),
  phase: z.string().nullish(),
  quick_replies: z.array(z.string()).nullish(),
  assessment: looseAssessmentSchema.nullish(),
});

type LooseTurn = z.infer<typeof turnSchema>;

const text = (v: unknown, fallback = "") =>
  typeof v === "string" && v.trim().length > 0 ? v.trim() : fallback;

function shortVoiceReply(value: string): string {
  const clean = value.replace(/[*_`#>|~]/g, " ").replace(/\s+/g, " ").trim();
  const sentences = clean.match(/[^.!?؟]+[.!?؟]?/g) ?? [clean];
  const twoSentences = sentences.slice(0, 2).join(" ").trim();
  const words = twoSentences.split(/\s+/).filter(Boolean);
  return words.length <= 25 ? twoSentences : `${words.slice(0, 25).join(" ").replace(/[,:;]$/, "")}.`;
}

function normaliseTurn(raw: LooseTurn, voice = false): TriageTurn {
  const a = raw.assessment;
  const hasAssessment =
    !!a && (text(a.summary) !== "" || (a.possible_conditions?.length ?? 0) > 0);
  const phase = text(raw.phase) === "assessment" && hasAssessment ? "assessment" : "asking";

  if (phase === "asking" || !a) {
    return {
      reply: voice
        ? shortVoiceReply(text(raw.reply, "Could you tell me a little more about what you're experiencing?"))
        : text(raw.reply, "Could you tell me a little more about what you're experiencing?"),
      phase: "asking",
      quick_replies: (raw.quick_replies ?? []).filter((q) => text(q) !== "").slice(0, 5),
      assessment: null,
    };
  }

  const urgencyRaw = text(a.urgency, "routine").toLowerCase();
  const urgency =
    urgencyRaw === "emergency" || urgencyRaw === "urgent" ? urgencyRaw : ("routine" as const);

  return {
    reply: voice
      ? shortVoiceReply(text(raw.reply, "Your symptom summary and next step are ready on screen."))
      : text(raw.reply, "Here's a summary of what you've described."),
    phase: "assessment",
    quick_replies: [],
    assessment: {
      summary: text(a.summary),
      collected: {
        symptoms: text(a.collected?.symptoms),
        duration: text(a.collected?.duration),
        severity: text(a.collected?.severity),
        related_symptoms: text(a.collected?.related_symptoms),
      },
      possible_conditions: (a.possible_conditions ?? [])
        .map((c) => ({
          name: text(c.name),
          explanation: text(c.explanation),
          why_relevant: text(c.why_relevant),
        }))
        .filter((c) => c.name !== ""),
      recommended_specialty: text(a.recommended_specialty, "General Physician"),
      urgency,
      urgency_reason: text(a.urgency_reason),
      red_flags: (a.red_flags ?? []).filter((r) => text(r) !== ""),
      safety_message: text(
        a.safety_message,
        "This is guidance only, not a diagnosis. If your symptoms worsen or you feel unsafe, seek emergency care immediately.",
      ),
    },
  };
}

const SYSTEM_PROMPT = `You are CarePath AI, a healthcare navigation and symptom guidance assistant. You are NOT a diagnostic device and never replace a clinician.

Your job: through a short, natural conversation, understand a person's symptoms well enough to suggest (a) possible health concern categories, (b) an appropriate medical specialty, and (c) an urgency level.

RULES
- Never state a confirmed diagnosis. Never say "you have X", "this confirms X" or "you are suffering from X". Use "possible causes include", "these symptoms can be associated with", "a healthcare professional should assess this".
- Never prescribe medication, dosages or treatment plans.
- Never invent doctors, hospitals, clinics, ratings or reviews. You do not have provider data.
- Ask ONE focused question at a time. Only ask what is genuinely still missing (symptoms, onset/duration, trajectory, severity, location on the body, related symptoms, prior episodes, warning signs). Do not interrogate: after 3-5 useful exchanges, produce the assessment.
- EMERGENCY OVERRIDE: if the person describes possible life-threatening red flags (severe chest pain, difficulty breathing, severe bleeding, loss of consciousness, stroke signs such as face droop/one-sided weakness/speech trouble, severe allergic reaction, suicidal crisis, severe head injury, etc.) immediately set phase to "assessment" with urgency "emergency" — do not ask more questions, do not delay.
- recommended_specialty must be a concrete specialty name such as "General Physician", "Dermatologist", "Cardiologist", "Neurologist", "ENT Specialist", "Gastroenterologist", "Orthopedic Specialist", "Gynecologist", "Urologist", "Ophthalmologist", "Psychiatrist", "Emergency Department".
- possible_conditions: 2 to 4 entries when phase is "assessment", each with careful, uncertainty-preserving wording.
- quick_replies: up to 5 short tappable answer options for your current question (empty array when phase is "assessment").
- When phase is "asking", assessment must be null. When phase is "assessment", assessment must be filled and reply should be one short sentence introducing the summary.
- CHAT MODE LENGTH: keep replies to 1-3 short sentences (max ~40 words). Acknowledge what they said in a few words, then ask your one question. Never write paragraphs, lists or long explanations in the reply — details belong in the assessment fields only.
- LANGUAGE: always reply in the same language the person is using. If they write or speak Urdu (Urdu script or Roman Urdu), reply in that same style of Urdu. Otherwise reply in English. The reply may be read aloud, so write it as natural spoken sentences without markdown, bullets or emojis. Keep the assessment fields themselves in English.
- Your replies may be spoken by a voice assistant acting like a caring doctor: acknowledge what the person said briefly before asking the next question.`;

function extractJson(raw: string): unknown {
  const trimmed = raw.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "");
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

const VOICE_PROMPT = `
VOICE CALL MODE: your reply will be spoken aloud on a live phone-style call. This overrides every other length instruction.
- HARD LIMIT: every reply is at most 2 short sentences and under 25 words. Never longer, no exceptions.
- Ask only ONE short question and stop. No lists, no numbering, no options read out.
- Plain spoken words only: no markdown, no asterisks, no hyphens as bullets, no emojis, no parentheses, no abbreviations like "e.g." or "etc.".
- When you reach the assessment, the spoken reply must be a single short sentence saying the summary is now on screen; the details stay in the assessment fields.`;

export async function runTriageTurn(
  messages: ChatTurn[],
  voice = false,
): Promise<TriageTurn> {
  const model = getChatModel();
  try {
    // Always stream gateway calls, even though this server function only returns
    // the completed object. Streaming keeps long model responses alive instead
    // of leaving one silent request that the platform can cancel with HTTP 499.
    const result = streamText({
      model,
      system: voice ? `${SYSTEM_PROMPT}\n${VOICE_PROMPT}` : SYSTEM_PROMPT,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      output: Output.object({ schema: turnSchema }),
      maxRetries: 0,
    });
    const output = await result.output;
    return normaliseTurn(output as LooseTurn, voice);
  } catch (error) {
    if (NoObjectGeneratedError.isInstance(error) && error.text) {
      const parsed = turnSchema.safeParse(extractJson(error.text));
      if (parsed.success) return normaliseTurn(parsed.data, voice);
    }
    throw error;
  }
}

const insightsSchema = z.object({
  enough_data: z.boolean(),
  message: z.string(),
  liked: z.array(z.string()),
  criticised: z.array(z.string()),
  themes: z.array(z.string()),
  sentiment: z.string(),
});

export async function summariseReviews(
  providerName: string,
  reviews: ProviderReview[],
): Promise<ReviewInsights> {
  const usable = reviews.filter((r) => (r.text ?? "").trim().length > 0);
  if (usable.length < 3) {
    return {
      enough_data: false,
      message: "Not enough review data was available to generate a reliable summary.",
      liked: [],
      criticised: [],
      themes: [],
      sentiment: "Unknown",
      reviews_analyzed: usable.length,
    };
  }
  const model = getChatModel();
  const corpus = usable
    .map((r, i) => `Review ${i + 1} (${r.rating ?? "no"} stars): ${r.text}`)
    .join("\n\n");
  const result = streamText({
    model,
    system: `You summarise ONLY the patient reviews given to you for a healthcare provider. Never invent facts, never generalise beyond the supplied text, never claim "patients agree". Use cautious phrasing such as "common themes in the available reviews include". If the reviews are too few or too thin to support a theme, say so and set enough_data to false. Keep every bullet under 15 words.`,
    prompt: `Provider: ${providerName}\nNumber of reviews available: ${usable.length}\n\n${corpus}`,
    output: Output.object({ schema: insightsSchema }),
    maxRetries: 0,
  });
  const output = await result.output;
  return { ...(output as z.infer<typeof insightsSchema>), reviews_analyzed: usable.length };
}