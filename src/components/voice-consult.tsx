import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Mic, PhoneOff, Volume2 } from "lucide-react";

type Status = "connecting" | "listening" | "transcribing" | "thinking" | "speaking" | "error";

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
}: {
  onUserSpeech: (text: string) => void;
  onEnd: () => void;
  isThinking: boolean;
  spokenReply: string;
  replyKey: number;
  transcriptPreview: string;
}) {
  const [status, setStatus] = useState<Status>("connecting");
  const [level, setLevel] = useState(0);
  const [message, setMessage] = useState<string | null>(null);
  const [heard, setHeard] = useState("");

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
  const spokenKeyRef = useRef(0);
  const endedRef = useRef(false);

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
        captureRef.current = true;
        setStatus("listening");
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
      nodeRef.current?.disconnect();
      sourceRef.current?.disconnect();
      streamRef.current?.getTracks().forEach((t) => t.stop());
      void ctxRef.current?.close().catch(() => undefined);
    };
  }, [finishUtterance]);

  // Speak each new assistant reply, then resume listening.
  useEffect(() => {
    if (!replyKey || replyKey === spokenKeyRef.current || !spokenReply.trim()) return;
    spokenKeyRef.current = replyKey;
    let cancelled = false;
    (async () => {
      captureRef.current = false;
      speakingRef.current = true;
      setStatus("speaking");
      try {
        const response = await fetch("/api/voice/speak", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: spokenReply }),
        });
        if (!response.ok) throw new Error(await response.text());
        const url = URL.createObjectURL(await response.blob());
        const audio = new Audio(url);
        audioRef.current = audio;
        await new Promise<void>((resolve) => {
          audio.onended = () => resolve();
          audio.onerror = () => resolve();
          void audio.play().catch(() => resolve());
        });
        URL.revokeObjectURL(url);
      } catch {
        setMessage("The voice reply could not be played, but the answer is on screen.");
      } finally {
        speakingRef.current = false;
        if (!cancelled && !endedRef.current) {
          resetUtterance();
          captureRef.current = true;
          setStatus("listening");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [replyKey, spokenReply]);

  useEffect(() => {
    if (isThinking) setStatus("thinking");
  }, [isThinking]);

  const label: Record<Status, string> = {
    connecting: "Connecting your microphone…",
    listening: "Listening — just speak naturally",
    transcribing: "Got it, processing what you said…",
    thinking: "CarePath AI is thinking…",
    speaking: "CarePath AI is speaking…",
    error: "Voice consultation unavailable",
  };

  return (
    <section className="mt-5 rounded-2xl border border-teal/40 bg-card p-5 shadow-lift">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-base font-semibold">Voice consultation</h2>
          <p className="text-xs text-muted-foreground">
            Hands-free. Speak in English or Urdu — pause when you finish talking.
          </p>
        </div>
        <button
          type="button"
          onClick={onEnd}
          className="focus-ring inline-flex shrink-0 items-center gap-1.5 rounded-xl border border-destructive/40 px-3 py-2 text-xs font-semibold text-destructive hover:bg-danger-soft"
        >
          <PhoneOff className="size-3.5" aria-hidden /> End call
        </button>
      </div>

      <div className="mt-5 flex flex-col items-center gap-3">
        <div className="relative grid size-24 place-items-center">
          <span
            className="absolute inset-0 rounded-full bg-teal/20 transition-transform duration-100"
            style={{
              transform: `scale(${status === "listening" ? 0.7 + level * 0.6 : 0.75})`,
            }}
            aria-hidden
          />
          <span className="relative grid size-16 place-items-center rounded-full bg-teal text-teal-foreground">
            {status === "speaking" ? (
              <Volume2 className="size-6" aria-hidden />
            ) : status === "thinking" || status === "transcribing" || status === "connecting" ? (
              <Loader2 className="size-6 animate-spin" aria-hidden />
            ) : (
              <Mic className="size-6" aria-hidden />
            )}
          </span>
        </div>
        <p className="text-sm font-medium" aria-live="polite">
          {label[status]}
        </p>
        {heard ? (
          <p className="max-w-md text-center text-xs text-muted-foreground">You said: “{heard}”</p>
        ) : null}
        {transcriptPreview && status === "speaking" ? (
          <p className="max-w-md text-center text-xs text-muted-foreground">{transcriptPreview}</p>
        ) : null}
        {message ? (
          <p className="max-w-md text-center text-xs text-destructive">{message}</p>
        ) : null}
      </div>
    </section>
  );
}
