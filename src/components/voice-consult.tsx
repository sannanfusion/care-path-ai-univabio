import { useCallback, useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronUp,
  Loader2,
  Mic,
  MicOff,
  PhoneOff,
  RotateCcw,
  Send,
  SkipForward,
  Volume2,
  VolumeX,
} from "lucide-react";


type Status = "connecting" | "listening" | "paused" | "transcribing" | "thinking" | "speaking" | "error";

const TARGET_RATE = 16000;
const SPEECH_THRESHOLD = 0.02;
const SILENCE_THRESHOLD = 0.014;
const SILENCE_MS = 1100;
const MAX_UTTERANCE_MS = 20000;

function downsample(chunks: Float32Array[], from: number): Float32Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const merged = new Float32Array(total);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.length;
  }
  if (from <= TARGET_RATE) return merged;
  const ratio = from / TARGET_RATE;
  const out = new Float32Array(Math.floor(merged.length / ratio));
  for (let i = 0; i < out.length; i += 1) out[i] = merged[Math.floor(i * ratio)] ?? 0;
  return out;
}

function encodeWav(samples: Float32Array): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeString = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i += 1) view.setUint8(offset + i, value.charCodeAt(i));
  };
  writeString(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, TARGET_RATE, true);
  view.setUint32(28, TARGET_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, "data");
  view.setUint32(40, samples.length * 2, true);
  let offset = 44;
  for (let i = 0; i < samples.length; i += 1) {
    const s = Math.max(-1, Math.min(1, samples[i] ?? 0));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }
  return new Blob([buffer], { type: "audio/wav" });
}

/** Strip markdown/symbols and keep the spoken reply to a couple of short sentences. */
function toSpeech(raw: string): string {
  const clean = raw
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`#>|~]/g, " ")
    .replace(/^\s*[-•]\s+/gm, " ")
    .replace(/\s*\([^)]*\)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const sentences = clean.match(/[^.!?؟]+[.!?؟]?/g) ?? [clean];
  let out = sentences.slice(0, 2).join(" ").trim();
  if (out.length > 240) out = `${out.slice(0, 237).trim()}…`;
  return out;
}

export function VoiceConsult({
  onUserSpeech,
  onEnd,
  isThinking,
  spokenReply,
  replyKey,
  transcriptPreview,
  voiceError,
}: {
  onUserSpeech: (text: string) => void;
  onEnd: () => void;
  isThinking: boolean;
  spokenReply: string;
  replyKey: number;
  transcriptPreview: string;
  voiceError?: string | null;
}) {
  const [status, setStatus] = useState<Status>("connecting");
  const [level, setLevel] = useState(0);
  const [message, setMessage] = useState<string | null>(null);
  const [heard, setHeard] = useState("");
  const [typed, setTyped] = useState("");
  const [paused, setPaused] = useState(true);
  const [collapsed, setCollapsed] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [replayKey, setReplayKey] = useState(0);
  const [agentMuted, setAgentMuted] = useState(false);


  const streamRef = useRef<MediaStream | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const nodeRef = useRef<ScriptProcessorNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const chunksRef = useRef<Float32Array[]>([]);
  const speakingRef = useRef(false);
  const startedRef = useRef(false);
  const silenceSinceRef = useRef<number | null>(null);
  const utteranceStartRef = useRef(0);
  const captureRef = useRef(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const playbackDoneRef = useRef<(() => void) | null>(null);
  const spokenKeyRef = useRef(0);
  const endedRef = useRef(false);
  const pausedRef = useRef(false);
  pausedRef.current = paused;
  const agentMutedRef = useRef(false);
  agentMutedRef.current = agentMuted;

  const resetUtterance = () => {
    chunksRef.current = [];
    startedRef.current = false;
    silenceSinceRef.current = null;
    utteranceStartRef.current = Date.now();
  };

  const finishUtterance = useCallback(async () => {
    captureRef.current = false;
    const samples = downsample(chunksRef.current, ctxRef.current?.sampleRate ?? 48000);
    resetUtterance();
    const blob = encodeWav(samples);
    if (blob.size < 8000) {
      captureRef.current = true;
      return;
    }
    setStatus("transcribing");
    try {
      const form = new FormData();
      form.append("file", blob, "recording.wav");
      const response = await fetch("/api/voice/transcribe", { method: "POST", body: form });
      const data = (await response.json()) as { text?: string; error?: string };
      if (!response.ok) throw new Error(data.error ?? "Could not understand that.");
      const text = (data.text ?? "").trim();
      if (text.length < 2) {
        captureRef.current = true;
        setStatus("listening");
        return;
      }
      setHeard(text);
      setMessage(null);
      setStatus("thinking");
      onUserSpeech(text);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not understand that.");
      captureRef.current = true;
      setStatus("listening");
    }
  }, [onUserSpeech]);

  // Start the microphone once when the call opens.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        const ctx = new AudioContext();
        ctxRef.current = ctx;
        const source = ctx.createMediaStreamSource(stream);
        sourceRef.current = source;
        const node = ctx.createScriptProcessor(4096, 1, 1);
        nodeRef.current = node;
        node.onaudioprocess = (event) => {
          const input = event.inputBuffer.getChannelData(0);
          let sum = 0;
          for (let i = 0; i < input.length; i += 1) sum += (input[i] ?? 0) ** 2;
          const rms = Math.sqrt(sum / input.length);
          setLevel(Math.min(1, rms * 12));
          if (!captureRef.current || speakingRef.current) return;
          if (!startedRef.current) {
            if (rms > SPEECH_THRESHOLD) {
              startedRef.current = true;
              utteranceStartRef.current = Date.now();
              chunksRef.current.push(new Float32Array(input));
            }
            return;
          }
          chunksRef.current.push(new Float32Array(input));
          const now = Date.now();
          if (rms < SILENCE_THRESHOLD) {
            silenceSinceRef.current ??= now;
            if (now - silenceSinceRef.current > SILENCE_MS) void finishUtterance();
          } else {
            silenceSinceRef.current = null;
          }
          if (now - utteranceStartRef.current > MAX_UTTERANCE_MS) void finishUtterance();
        };
        source.connect(node);
        node.connect(ctx.destination);
        resetUtterance();
        captureRef.current = !pausedRef.current;
        setStatus(pausedRef.current ? "paused" : "listening");
      } catch {
        setStatus("error");
        setMessage("Microphone access is needed for a voice consultation. Please allow it and try again.");
      }
    })();

    return () => {
      cancelled = true;
      endedRef.current = true;
      captureRef.current = false;
      audioRef.current?.pause();
      playbackDoneRef.current?.();
      nodeRef.current?.disconnect();
      sourceRef.current?.disconnect();
      streamRef.current?.getTracks().forEach((t) => t.stop());
      void ctxRef.current?.close().catch(() => undefined);
    };
  }, [finishUtterance]);

  // Speak each new assistant reply (or a replay), then resume listening.
  useEffect(() => {
    const isReplay = replayKey > 0;
    if (!isReplay && (!replyKey || replyKey === spokenKeyRef.current)) return;
    if (!spokenReply.trim()) return;
    if (!isReplay) spokenKeyRef.current = replyKey;
    if (agentMutedRef.current) return;
    let cancelled = false;
    (async () => {
      captureRef.current = false;
      speakingRef.current = true;
      setStatus("speaking");
      try {
        const response = await fetch("/api/voice/speak", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: toSpeech(spokenReply) }),
        });
        if (!response.ok) throw new Error(await response.text());
        const url = URL.createObjectURL(await response.blob());
        const audio = new Audio(url);
        audioRef.current = audio;
        await new Promise<void>((resolve) => {
          const finish = () => {
            playbackDoneRef.current = null;
            resolve();
          };
          playbackDoneRef.current = finish;
          audio.onended = finish;
          audio.onerror = finish;
          void audio.play().catch(() => resolve());
        });
        URL.revokeObjectURL(url);
      } catch {
        setMessage("The voice reply could not be played, but the answer is on screen.");
      } finally {
        speakingRef.current = false;
        if (!cancelled && !endedRef.current) {
          resetUtterance();
          captureRef.current = !pausedRef.current;
          setStatus(pausedRef.current ? "paused" : "listening");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [replyKey, spokenReply, replayKey]);

  useEffect(() => {
    if (isThinking) setStatus("thinking");
  }, [isThinking]);

  useEffect(() => {
    if (!voiceError) return;
    setMessage(voiceError);
    captureRef.current = !pausedRef.current;
    setStatus(pausedRef.current ? "paused" : "listening");
  }, [voiceError]);

  // Call duration.
  useEffect(() => {
    const id = window.setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => window.clearInterval(id);
  }, []);

  // Mic toggle only mutes the human microphone — the AI voice keeps playing.
  function togglePause() {
    const next = !paused;
    pausedRef.current = next;
    setPaused(next);
    if (next) {
      captureRef.current = false;
      resetUtterance();
      if (!speakingRef.current) setStatus("paused");
    } else {
      resetUtterance();
      captureRef.current = !speakingRef.current;
      if (!speakingRef.current) setStatus("listening");
    }
  }

  // Mutes/unmutes the AI voice only — the call and your mic keep working.
  function toggleAgentMute() {
    const next = !agentMuted;
    setAgentMuted(next);
    if (next) {
      audioRef.current?.pause();
      playbackDoneRef.current?.();
      audioRef.current = null;
      speakingRef.current = false;
      if (status === "speaking") {
        resetUtterance();
        captureRef.current = !pausedRef.current;
        setStatus(pausedRef.current ? "paused" : "listening");
      }
    }
  }

  function skipSpeech() {
    audioRef.current?.pause();
    playbackDoneRef.current?.();
    audioRef.current = null;
    speakingRef.current = false;
    resetUtterance();
    captureRef.current = !paused;
    setStatus(paused ? "paused" : "listening");
  }

  const clock = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;



  const label: Record<Status, string> = {
    connecting: "Connecting your microphone…",
    listening: "Listening — just speak naturally",
    paused: "Microphone off — tap “Turn mic on” when you're ready to speak",
    transcribing: "Got it, processing what you said…",
    thinking: "CarePath AI is thinking…",
    speaking: "CarePath AI is speaking…",
    error: "Voice consultation unavailable",
  };

  return (
    <section className="sticky top-2 z-30 mt-5 overflow-hidden rounded-2xl border border-teal/40 bg-card/95 shadow-lift backdrop-blur supports-[backdrop-filter]:bg-card/80">
      <div className="flex items-center justify-between gap-3 border-b border-border/70 px-4 py-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="relative grid size-9 shrink-0 place-items-center rounded-xl bg-teal text-teal-foreground">
            {status === "speaking" ? (
              <Volume2 className="size-4" aria-hidden />
            ) : status === "thinking" || status === "transcribing" || status === "connecting" ? (
              <Loader2 className="size-4 animate-spin" aria-hidden />
            ) : paused ? (
              <MicOff className="size-4" aria-hidden />
            ) : (
              <Mic className="size-4" aria-hidden />
            )}
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">Voice consultation</p>
            <p className="truncate text-[11px] text-muted-foreground" aria-live="polite">
              {label[status]}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="rounded-lg bg-surface px-2 py-1 font-mono text-[11px] tabular-nums text-muted-foreground">
            {clock}
          </span>
          <button
            type="button"
            onClick={() => setCollapsed((c) => !c)}
            aria-label={collapsed ? "Expand call panel" : "Collapse call panel"}
            className="focus-ring grid size-8 place-items-center rounded-lg border border-border hover:bg-secondary"
          >
            {collapsed ? <ChevronDown className="size-4" aria-hidden /> : <ChevronUp className="size-4" aria-hidden />}
          </button>
          <button
            type="button"
            onClick={onEnd}
            className="focus-ring inline-flex items-center gap-1.5 rounded-xl bg-destructive px-3 py-2 text-xs font-semibold text-white"
          >
            <PhoneOff className="size-3.5" aria-hidden /> End
          </button>
        </div>
      </div>

      {!collapsed ? (
        <div className="px-4 pb-4">
          <div className="mt-4 flex flex-col items-center gap-3">
            <div className="relative grid size-24 place-items-center">
              <span
                className="absolute inset-0 rounded-full bg-teal/20 transition-transform duration-100"
                style={{ transform: `scale(${status === "listening" ? 0.7 + level * 0.6 : 0.75})` }}
                aria-hidden
              />
              <span
                className={`relative grid size-16 place-items-center rounded-full text-teal-foreground ${
                  paused ? "bg-muted-foreground" : "bg-teal"
                }`}
              >
                {status === "speaking" ? (
                  <Volume2 className="size-6" aria-hidden />
                ) : status === "thinking" || status === "transcribing" || status === "connecting" ? (
                  <Loader2 className="size-6 animate-spin" aria-hidden />
                ) : paused ? (
                  <MicOff className="size-6" aria-hidden />
                ) : (
                  <Mic className="size-6" aria-hidden />
                )}
              </span>
            </div>

            <div className="flex flex-wrap items-center justify-center gap-2">
              <button
                type="button"
                onClick={togglePause}
                className="focus-ring inline-flex items-center gap-1.5 rounded-xl border border-border px-3 py-2 text-xs font-semibold hover:bg-secondary"
              >
                {paused ? <Mic className="size-3.5" aria-hidden /> : <MicOff className="size-3.5" aria-hidden />}
                {paused ? "Turn mic on" : "Turn mic off"}
              </button>
              <button
                type="button"
                onClick={toggleAgentMute}
                className="focus-ring inline-flex items-center gap-1.5 rounded-xl border border-border px-3 py-2 text-xs font-semibold hover:bg-secondary"
              >
                {agentMuted ? <Volume2 className="size-3.5" aria-hidden /> : <VolumeX className="size-3.5" aria-hidden />}
                {agentMuted ? "Unmute AI voice" : "Mute AI voice"}
              </button>
              <button
                type="button"
                onClick={skipSpeech}
                disabled={status !== "speaking"}
                className="focus-ring inline-flex items-center gap-1.5 rounded-xl border border-border px-3 py-2 text-xs font-semibold hover:bg-secondary disabled:opacity-40"
              >
                <SkipForward className="size-3.5" aria-hidden /> Skip reply
              </button>
              <button
                type="button"
                onClick={() => {
                  setAgentMuted(false);
                  setReplayKey((k) => k + 1);
                }}
                disabled={!spokenReply.trim() || status === "speaking"}
                className="focus-ring inline-flex items-center gap-1.5 rounded-xl border border-border px-3 py-2 text-xs font-semibold hover:bg-secondary disabled:opacity-40"
              >
                <RotateCcw className="size-3.5" aria-hidden /> Repeat
              </button>
            </div>

            {heard ? (
              <p className="max-w-md text-center text-xs text-muted-foreground">You said: “{heard}”</p>
            ) : null}
            {transcriptPreview && status === "speaking" ? (
              <p className="max-w-md text-center text-xs text-muted-foreground">
                {toSpeech(transcriptPreview)}
              </p>
            ) : null}
            {message ? (
              <p className="max-w-md text-center text-xs text-destructive">{message}</p>
            ) : null}
          </div>

          <form
            onSubmit={(event) => {
              event.preventDefault();
              const value = typed.trim();
              if (!value) return;
              setTyped("");
              setHeard(value);
              onUserSpeech(value);
            }}
            className="mt-4 flex items-center gap-2 border-t border-border pt-3"
          >
            <label htmlFor="voice-typed" className="sr-only">
              Type instead of speaking
            </label>
            <input
              id="voice-typed"
              value={typed}
              maxLength={2000}
              disabled={isThinking}
              onChange={(event) => setTyped(event.target.value)}
              placeholder={isThinking ? "CarePath AI is thinking…" : "Prefer to type? Write your answer here…"}
              className="focus-ring min-h-10 w-full min-w-0 flex-1 rounded-xl border border-border bg-surface px-3 py-2 text-base outline-none sm:text-sm"
            />
            <button
              type="submit"
              disabled={isThinking || !typed.trim()}
              className="focus-ring grid size-10 shrink-0 place-items-center rounded-xl bg-teal text-teal-foreground disabled:opacity-40"
              aria-label="Send typed answer"
            >
              <Send className="size-4" aria-hidden />
            </button>
          </form>
          <p className="mt-2 text-center text-[11px] text-muted-foreground">
            Everything you say is written into the conversation below as you talk.
          </p>
        </div>
      ) : null}
    </section>
  );
}

