import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useMutation } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Loader2, Mic, RotateCcw, Send, Stethoscope } from "lucide-react";
import { SiteNav } from "@/components/site-nav";
import { EmergencyPanel } from "@/components/emergency-panel";
import { VoiceConsult } from "@/components/voice-consult";
import { triageTurn } from "@/lib/carepath.functions";
import { setAssessment } from "@/lib/care-session";
import { URGENCY_STYLES } from "@/lib/provider-utils";
import type { Assessment, ChatTurn } from "@/lib/types";

export const Route = createFileRoute("/symptom-check")({
  head: () => ({
    meta: [
      { title: "Symptom Check — CarePath AI guided health assessment" },
      {
        name: "description",
        content:
          "Describe your symptoms and get structured, safety-aware guidance on possible health concerns, the right medical specialty and how urgent it may be.",
      },
      { property: "og:title", content: "Symptom Check — CarePath AI" },
      {
        property: "og:description",
        content:
          "Conversational symptom guidance with specialty and urgency recommendations. Not a diagnosis.",
      },
    ],
  }),
  component: SymptomCheckPage,
});

const OPENING =
  "Hi, I'm CarePath AI. Tell me what you're experiencing, and I'll help you understand what type of medical care may be appropriate.";

const STARTERS = [
  "I've had a persistent skin rash on my arm for two weeks. It is itchy and getting worse.",
  "I've had a sore throat and fever since yesterday.",
  "I get headaches most afternoons this month.",
];

function SymptomCheckPage() {
  const navigate = useNavigate();
  const call = useServerFn(triageTurn);
  const [isReady, setIsReady] = useState(false);
  const [voiceOn, setVoiceOn] = useState(false);
  const [messages, setMessages] = useState<ChatTurn[]>([{ role: "assistant", content: OPENING }]);
  const [quickReplies, setQuickReplies] = useState<string[]>([]);
  const [assessment, setLocalAssessment] = useState<Assessment | null>(null);
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);
  const requestIdRef = useRef(0);

  useEffect(() => {
    setIsReady(true);
  }, []);

  const mutation = useMutation({
    mutationFn: ({
      conversation,
      voice,
    }: {
      conversation: ChatTurn[];
      requestId: number;
      voice?: boolean;
    }) => call({ data: { messages: conversation, voice: voice ?? false } }),
    retry: false,
    onSuccess: (turn, variables) => {
      if (variables.requestId !== requestIdRef.current) return;
      setMessages((prev) => [...prev, { role: "assistant", content: turn.reply }]);
      setQuickReplies(turn.quick_replies ?? []);
      if (turn.phase === "assessment" && turn.assessment) {
        setLocalAssessment(turn.assessment);
        setAssessment(turn.assessment);
      }
    },
    onError: (error, variables) => {
      if (variables.requestId !== requestIdRef.current) return;
      const message = error instanceof Error ? error.message : String(error);
      setError(formatGuidanceError(message));
    },
  });

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, assessment, mutation.isPending]);

  function send(text: string) {
    const value = text.trim();
    if (!isReady || !value || mutation.isPending) return;
    setError(null);
    setQuickReplies([]);
    setInput("");
    const next: ChatTurn[] = [...messages, { role: "user", content: value }];
    setMessages(next);
    const requestId = ++requestIdRef.current;
    mutation.mutate({
      conversation: next
        .filter((m, i) => !(i === 0 && m.role === "assistant"))
        .slice(-10),
      requestId,
      voice: voiceOn,
    });
  }

  function restart() {
    requestIdRef.current += 1;
    mutation.reset();
    setMessages([{ role: "assistant", content: OPENING }]);
    setQuickReplies([]);
    setLocalAssessment(null);
    setAssessment(null);
    setError(null);
  }

  function editLast() {
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    const idx = messages.findIndex((m) => m === lastUser);
    if (idx < 0) return;
    setInput(lastUser?.content ?? "");
    setMessages(messages.slice(0, idx));
    setLocalAssessment(null);
    setQuickReplies([]);
  }

  const answered = messages.filter((m) => m.role === "user").length;
  const progress = assessment ? 100 : Math.min(90, answered * 22);
  const assistantMessages = messages.filter((m) => m.role === "assistant");
  const assistantCount = assistantMessages.length;
  const lastAssistant = assistantMessages[assistantCount - 1]?.content ?? "";

  return (
    <div className="min-h-screen pb-24 md:pb-0">
      <SiteNav />
      <main className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-6">
        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3">
          <div className="min-w-0">
            <h1 className="text-2xl font-bold sm:text-3xl">Symptom Check</h1>
            <p className="text-sm text-muted-foreground">
              Guided questions, then a structured summary. Not a diagnosis.
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => setVoiceOn((on) => !on)}
              disabled={!isReady}
              className={`focus-ring inline-flex shrink-0 items-center gap-1.5 rounded-xl px-3 py-2 text-xs font-semibold disabled:cursor-wait disabled:opacity-50 ${
                voiceOn
                  ? "bg-teal text-teal-foreground"
                  : "border border-teal/40 bg-teal-soft text-teal-foreground"
              }`}
            >
              <Mic className="size-3.5" aria-hidden /> {voiceOn ? "Voice on" : "Talk to CarePath"}
            </button>
            <button
              type="button"
              onClick={restart}
              disabled={!isReady}
              className="focus-ring inline-flex shrink-0 items-center gap-1.5 rounded-xl border border-border px-3 py-2 text-xs font-semibold hover:bg-secondary disabled:cursor-wait disabled:opacity-50"
            >
              <RotateCcw className="size-3.5" aria-hidden /> Start over
            </button>
          </div>
        </div>

        {voiceOn ? (
          <VoiceConsult
            onUserSpeech={send}
            onEnd={() => setVoiceOn(false)}
            isThinking={mutation.isPending}
            spokenReply={lastAssistant}
            replyKey={assistantCount}
            transcriptPreview={lastAssistant}
          />
        ) : null}

        <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-surface" aria-hidden>
          <div
            className="h-full rounded-full bg-teal transition-all duration-500"
            style={{ width: `${progress}%` }}
          />
        </div>


        <section className="mt-5 space-y-3" aria-live="polite">
          {messages.map((m, i) => (
            <div
              key={`${i}-${m.content.slice(0, 12)}`}
              className={m.role === "user" ? "flex justify-end" : "flex gap-2.5"}
            >
              {m.role === "assistant" ? (
                <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-xl bg-primary text-primary-foreground">
                  <Stethoscope className="size-4 text-teal" aria-hidden />
                </span>
              ) : null}
              <p
                className={
                  m.role === "user"
                    ? "max-w-[85%] rounded-2xl rounded-br-md bg-primary px-4 py-3 text-sm text-primary-foreground"
                    : "max-w-[85%] rounded-2xl rounded-tl-md border border-border bg-card px-4 py-3 text-sm shadow-soft"
                }
              >
                {m.content}
              </p>
            </div>
          ))}

          {mutation.isPending ? (
            <div className="flex gap-2.5">
              <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-xl bg-primary text-primary-foreground">
                <Stethoscope className="size-4 text-teal" aria-hidden />
              </span>
              <div className="min-w-[12rem] rounded-2xl border border-border bg-card p-4 shadow-soft">
                <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                  <Loader2 className="size-3.5 animate-spin text-teal" aria-hidden />
                  <span>CarePath AI is thinking…</span>
                </div>
                <div className="mt-3 space-y-2">
                  <div className="h-3 w-40 animate-pulse rounded bg-surface" />
                  <div className="h-3 w-28 animate-pulse rounded bg-surface" />
                </div>
              </div>
            </div>
          ) : null}

          {error ? (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-destructive/40 bg-danger-soft p-3 text-sm text-destructive">
              <p>{error}</p>
              <button
                type="button"
                onClick={() => {
                  const lastUser = [...messages].reverse().find((message) => message.role === "user");
                  if (!lastUser) return;
                  const lastUserIndex = messages.lastIndexOf(lastUser);
                  const conversation = messages.slice(0, lastUserIndex + 1);
                  setError(null);
                  const requestId = ++requestIdRef.current;
                  mutation.mutate({
                    conversation: conversation.filter(
                      (message, index) => !(index === 0 && message.role === "assistant"),
                    ),
                    requestId,
                  });
                }}
                className="focus-ring rounded-lg border border-destructive/40 px-3 py-1.5 text-xs font-semibold hover:bg-card"
              >
                Try again
              </button>
            </div>
          ) : null}

          {messages.length === 1 && !mutation.isPending ? (
            <div className="flex flex-wrap gap-2 pt-1">
              {STARTERS.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => send(s)}
                  disabled={!isReady}
                  className="focus-ring rounded-full border border-border bg-card px-3 py-2 text-left text-xs font-medium hover:bg-secondary disabled:cursor-wait disabled:opacity-50"
                >
                  {s}
                </button>
              ))}
            </div>
          ) : null}

          {quickReplies.length > 0 && !mutation.isPending ? (
            <div className="flex flex-wrap gap-2 pt-1">
              {quickReplies.map((q) => (
                <button
                  key={q}
                  type="button"
                  onClick={() => send(q)}
                  disabled={!isReady}
                  className="focus-ring rounded-full border border-teal/40 bg-teal-soft px-3 py-2 text-xs font-semibold text-teal-foreground disabled:cursor-wait disabled:opacity-50"
                >
                  {q}
                </button>
              ))}
            </div>
          ) : null}
          <div ref={endRef} />
        </section>

        {!assessment ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              send(input);
            }}
            className="sticky bottom-[calc(4.5rem+env(safe-area-inset-bottom))] mt-5 rounded-2xl border border-border bg-card p-2 shadow-lift md:bottom-4"
          >
            <label htmlFor="symptom-input" className="sr-only">
              Describe your symptoms
            </label>
            <div className="flex items-end gap-2">
              <textarea
                id="symptom-input"
                rows={2}
                value={input}
                maxLength={2000}
                disabled={!isReady || mutation.isPending}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey && window.innerWidth >= 768) {
                    e.preventDefault();
                    send(input);
                  }
                }}
                placeholder={
                  !isReady
                    ? "Getting the symptom checker ready…"
                    : mutation.isPending
                    ? "CarePath AI is thinking…"
                    : "Describe what you're experiencing…"
                }
                className="focus-ring max-h-32 min-h-11 w-full min-w-0 flex-1 resize-none bg-transparent px-3 py-2.5 text-base outline-none sm:text-sm disabled:cursor-not-allowed disabled:opacity-60"
              />
              <button
                type="submit"
                disabled={!isReady || mutation.isPending || !input.trim()}
                className="focus-ring grid size-11 shrink-0 place-items-center rounded-xl bg-teal text-teal-foreground disabled:opacity-40"
                aria-label={mutation.isPending ? "AI is thinking" : "Send message"}
              >
                {mutation.isPending ? (
                  <Loader2 className="size-4 animate-spin" aria-hidden />
                ) : (
                  <Send className="size-4" aria-hidden />
                )}
              </button>
            </div>
            {messages.some((m) => m.role === "user") ? (
              <div className="mt-1 flex justify-start px-1">
                <button
                  type="button"
                  onClick={editLast}
                  disabled={mutation.isPending}
                  className="focus-ring rounded-lg px-2 py-1 text-xs font-semibold text-muted-foreground hover:bg-secondary disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Edit answer
                </button>
              </div>
            ) : null}
          </form>

        ) : (
          <AssessmentView
            assessment={assessment}
            onContinue={() =>
              navigate({
                to: "/find-care",
                search: {
                  specialty: assessment.recommended_specialty,
                  emergency: assessment.urgency === "emergency",
                },
              })
            }
            onRestart={restart}
          />
        )}
      </main>
    </div>
  );
}

function formatGuidanceError(message: string): string {
  const normalized = message.toLowerCase();
  if (normalized.includes("402") || normalized.includes("credit")) {
    return message || "AI guidance is unavailable because this workspace needs more AI credits.";
  }
  if (normalized.includes("403") || normalized.includes("disabled") || normalized.includes("policy")) {
    return message || "AI guidance is currently disabled for this workspace.";
  }
  if (normalized.includes("401") || normalized.includes("lovable_api_key")) {
    return "AI guidance is not configured correctly. Please contact the app owner.";
  }
  if (normalized.includes("429") || normalized.includes("rate limit")) {
    return "The guidance service is busy right now. Please wait a moment, then try again.";
  }
  return message && !normalized.includes("server function")
    ? message
    : "The guidance service could not complete this response. Please try again.";
}

function AssessmentView({
  assessment,
  onContinue,
  onRestart,
}: {
  assessment: Assessment;
  onContinue: () => void;
  onRestart: () => void;
}) {
  const urgency = URGENCY_STYLES[assessment.urgency] ?? URGENCY_STYLES["routine"]!;
  return (
    <div className="mt-6 space-y-4">
      {assessment.urgency === "emergency" ? (
        <EmergencyPanel redFlags={assessment.red_flags} reason={assessment.urgency_reason} />
      ) : null}

      <section className="card-soft p-5">
        <h2 className="text-lg font-semibold">Symptom summary</h2>
        <p className="mt-2 text-sm text-muted-foreground">{assessment.summary}</p>
        <dl className="mt-4 grid gap-3 sm:grid-cols-2">
          {[
            ["Symptoms", assessment.collected.symptoms],
            ["Duration", assessment.collected.duration],
            ["Severity", assessment.collected.severity],
            ["Related symptoms", assessment.collected.related_symptoms],
          ].map(([label, value]) => (
            <div key={label} className="rounded-xl bg-surface p-3">
              <dt className="text-xs font-semibold text-muted-foreground uppercase">{label}</dt>
              <dd className="mt-0.5 text-sm">{value || "Not provided"}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="card-soft p-5">
        <h2 className="text-lg font-semibold">Possible health concerns</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Based on the symptoms you described, these are possible conditions or health concerns
          that may be relevant. A qualified healthcare professional should evaluate you for an
          actual diagnosis.
        </p>
        <ul className="mt-4 space-y-3">
          {assessment.possible_conditions.map((c) => (
            <li key={c.name} className="rounded-xl border border-border p-4">
              <h3 className="text-sm font-semibold">{c.name}</h3>
              <p className="mt-1 text-sm text-muted-foreground">{c.explanation}</p>
              <p className="mt-2 text-xs text-muted-foreground">
                <span className="font-semibold text-foreground">Why it may relate: </span>
                {c.why_relevant}
              </p>
            </li>
          ))}
        </ul>
      </section>

      <section className="card-soft p-5">
        <h2 className="text-lg font-semibold">Recommended care</h2>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <span className="rounded-xl bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground">
            {assessment.recommended_specialty}
          </span>
          <span className={`rounded-xl px-3 py-2 text-sm font-semibold ${urgency.className}`}>
            {urgency.label}
          </span>
        </div>
        <p className="mt-3 text-sm text-muted-foreground">{assessment.urgency_reason}</p>
        <p className="mt-3 rounded-xl bg-surface p-3 text-xs text-muted-foreground">
          {assessment.safety_message}
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={onContinue}
            className="focus-ring rounded-xl bg-teal px-4 py-2.5 text-sm font-semibold text-teal-foreground"
          >
            Find {assessment.recommended_specialty} near me
          </button>
          <button
            type="button"
            onClick={onRestart}
            className="focus-ring inline-flex items-center gap-1.5 rounded-xl border border-border px-4 py-2.5 text-sm font-semibold hover:bg-secondary"
          >
            <ArrowLeft className="size-4" aria-hidden /> Start over
          </button>
          <Link
            to="/about"
            className="focus-ring rounded-xl px-4 py-2.5 text-sm font-semibold text-muted-foreground hover:bg-secondary"
          >
            How this works
          </Link>
        </div>
      </section>
    </div>
  );
}