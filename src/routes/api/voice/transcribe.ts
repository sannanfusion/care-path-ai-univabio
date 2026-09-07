import { createFileRoute } from "@tanstack/react-router";

const MAX_BYTES = 12 * 1024 * 1024;

export const Route = createFileRoute("/api/voice/transcribe")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const form = await request.formData();
          const file = form.get("file");
          if (!(file instanceof File) || file.size < 2048) {
            return Response.json({ error: "That recording was empty — please try again." }, { status: 400 });
          }
          if (file.size > MAX_BYTES) {
            return Response.json({ error: "That recording is too long." }, { status: 413 });
          }
          const { transcribeAudio } = await import("@/lib/voice.server");
          const result = await transcribeAudio(file);
          return Response.json(result);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.error("Voice transcription failed", message);
          return Response.json({ error: message }, { status: 502 });
        }
      },
    },
  },
});
