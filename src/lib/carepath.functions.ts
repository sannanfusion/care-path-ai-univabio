import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const chatInput = z.object({
  messages: z.array(
    z.object({ role: z.enum(["user", "assistant"]), content: z.string() }),
  ),
  voice: z.boolean().nullable().optional(),
});

const searchInput = z.object({
  specialty: z.string(),
  latitude: z.number().nullable().optional(),
  longitude: z.number().nullable().optional(),
  city: z.string().nullable().optional(),
  radiusKm: z.number().nullable().optional(),
  emergency: z.boolean().nullable().optional(),
});

const detailsInput = z.object({
  placeId: z.string(),
  latitude: z.number().nullable().optional(),
  longitude: z.number().nullable().optional(),
  specialty: z.string().nullable().optional(),
});

export const triageTurn = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => chatInput.parse(input))
  .handler(async ({ data }) => {
    const { runTriageTurn } = await import("./triage.server");
    return runTriageTurn(data.messages, data.voice === true);
  });

export const findProviders = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => searchInput.parse(input))
  .handler(async ({ data }) => {
    const { searchProviders } = await import("./places.server");
    return searchProviders({
      specialty: data.specialty,
      latitude: data.latitude ?? null,
      longitude: data.longitude ?? null,
      city: data.city ?? null,
      radiusKm: data.radiusKm ?? null,
      emergency: data.emergency ?? null,
    });
  });

export const providerDetails = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => detailsInput.parse(input))
  .handler(async ({ data }) => {
    const { getProviderDetails } = await import("./places.server");
    const center =
      typeof data.latitude === "number" && typeof data.longitude === "number"
        ? { lat: data.latitude, lng: data.longitude }
        : null;
    return getProviderDetails(data.placeId, center, data.specialty ?? "General Physician");
  });

export const reviewInsights = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        providerName: z.string(),
        reviews: z.array(
          z.object({
            author: z.string().nullable(),
            rating: z.number().nullable(),
            text: z.string().nullable(),
            relative_time: z.string().nullable(),
            publish_time: z.string().nullable(),
          }),
        ),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    const { summariseReviews } = await import("./triage.server");
    return summariseReviews(data.providerName, data.reviews);
  });