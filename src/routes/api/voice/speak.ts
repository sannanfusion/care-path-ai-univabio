import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/voice/speak")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const body = (await request.json()) as { text?: unknown };
          const text = typeof body.text === "string" ? body.text.trim().slice(0, 2500) : "";
          if (!text) return new Response("Missing text", { status: 400 });
          const { synthesizeSpeech } = await import("@/lib/voice.server");
          return await synthesizeSpeech(text);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.error("Voice synthesis failed", message);
          return new Response(message, { status: 502 });
        }
      },
    },
  },
});
