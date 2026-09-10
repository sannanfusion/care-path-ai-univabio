const API = "https://api.elevenlabs.io/v1";

/** Warm, calm female voice (Sarah) — works for English and Urdu via multilingual v2. */
const DEFAULT_VOICE_ID = "EXAVITQu4vr4xnSDxMaL";

function apiKeys(): string[] {
  const keys = [
    process.env["ELEVENLABS_API_KEY"],
    process.env["ELEVENLABS_API_KEY_2"],
    process.env["ELEVENLABS_API_KEY_3"],
  ].filter((key): key is string => Boolean(key));
  if (keys.length === 0) throw new Error("Voice features are not configured.");
  return [...new Set(keys)];
}

function canFailOver(status: number): boolean {
  return status === 401 || status === 402 || status === 403 || status === 429 || status >= 500;
}

export async function transcribeAudio(file: File | Blob): Promise<{ text: string; language: string | null }> {
  let lastError = "Transcription failed.";
  for (const key of apiKeys()) {
    const form = new FormData();
    form.append("file", file, "recording.wav");
    form.append("model_id", "scribe_v2");
    const response = await fetch(`${API}/speech-to-text`, {
      method: "POST",
      headers: { "xi-api-key": key },
      body: form,
    });
    if (response.ok) {
      const data = (await response.json()) as { text?: string; language_code?: string };
      return { text: (data.text ?? "").trim(), language: data.language_code ?? null };
    }
    const body = await response.text().catch(() => "");
    lastError = `Transcription failed [${response.status}]: ${body}`;
    if (!canFailOver(response.status)) break;
  }
  throw new Error(lastError);
}

export async function synthesizeSpeech(text: string): Promise<Response> {
  let lastError = "Speech synthesis failed.";
  for (const key of apiKeys()) {
    const response = await fetch(`${API}/text-to-speech/${DEFAULT_VOICE_ID}/stream?output_format=mp3_44100_128`, {
      method: "POST",
      headers: { "xi-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        model_id: "eleven_multilingual_v2",
        voice_settings: {
          stability: 0.55,
          similarity_boost: 0.75,
          style: 0.2,
          use_speaker_boost: true,
          speed: 1.0,
        },
      }),
    });
    if (response.ok && response.body) {
      return new Response(response.body, {
        headers: { "Content-Type": "audio/mpeg", "Cache-Control": "no-store" },
      });
    }
    const body = await response.text().catch(() => "");
    lastError = `Speech synthesis failed [${response.status}]: ${body}`;
    if (!canFailOver(response.status)) break;
  }
  throw new Error(lastError);
}
