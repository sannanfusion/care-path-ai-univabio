const API = "https://api.elevenlabs.io/v1";

/** Warm, calm female voice (Sarah) — works for English and Urdu via multilingual v2. */
const DEFAULT_VOICE_ID = "EXAVITQu4vr4xnSDxMaL";

function apiKey(): string {
  const key = process.env["ELEVENLABS_API_KEY"];
  if (!key) throw new Error("Voice features are not configured (missing ElevenLabs connection).");
  return key;
}

export async function transcribeAudio(file: File | Blob): Promise<{ text: string; language: string | null }> {
  const form = new FormData();
  form.append("file", file, "recording.wav");
  form.append("model_id", "scribe_v2");

  const response = await fetch(`${API}/speech-to-text`, {
    method: "POST",
    headers: { "xi-api-key": apiKey() },
    body: form,
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Transcription failed [${response.status}]: ${body}`);
  }

  const data = (await response.json()) as { text?: string; language_code?: string };
  return { text: (data.text ?? "").trim(), language: data.language_code ?? null };
}

export async function synthesizeSpeech(text: string): Promise<Response> {
  const response = await fetch(
    `${API}/text-to-speech/${DEFAULT_VOICE_ID}/stream?output_format=mp3_44100_128`,
    {
      method: "POST",
      headers: { "xi-api-key": apiKey(), "Content-Type": "application/json" },
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
    },
  );

  if (!response.ok || !response.body) {
    const body = await response.text().catch(() => "");
    throw new Error(`Speech synthesis failed [${response.status}]: ${body}`);
  }

  return new Response(response.body, {
    headers: { "Content-Type": "audio/mpeg", "Cache-Control": "no-store" },
  });
}
