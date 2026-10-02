import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import { z } from "zod"
import { errors } from "@ericsanchezok/synergy-server/server/error"
import { Voice, VoiceNotConfiguredError } from ".."

// MediaRecorder audio may arrive in containers typed as video/* (webm/mp4)
// by browser MIME databases, so the filename extension is a valid fallback.
const AUDIO_CONTAINER_EXTENSIONS = new Set([
  ".webm",
  ".mp3",
  ".mp4",
  ".m4a",
  ".ogg",
  ".oga",
  ".opus",
  ".wav",
  ".flac",
  ".aac",
])

function isAudioLike(file: File): boolean {
  if (file.type.startsWith("audio/")) return true
  const name = file.name ?? ""
  const dot = name.lastIndexOf(".")
  const ext = dot >= 0 ? name.slice(dot).toLowerCase() : ""
  return AUDIO_CONTAINER_EXTENSIONS.has(ext)
}
const MAX_AUDIO_BYTES = 25 * 1024 * 1024

const TranscriptionResult = z.object({ text: z.string() }).meta({ ref: "VoiceTranscriptionResult" })
const PreviewInput = z
  .object({ text: z.string().trim().min(1).max(200) })
  .strict()
  .meta({ ref: "VoicePreviewInput" })

export const VoiceRoute = () =>
  new Hono()
    .post(
      "/transcribe",
      describeRoute({
        summary: "Transcribe audio",
        description:
          "Transcribe a short audio recording using the saved speech recognition configuration. The canonical call recorder manages audio artifacts.",
        operationId: "voice.transcribe",
        responses: {
          200: {
            description: "Transcribed text",
            content: { "application/json": { schema: resolver(TranscriptionResult) } },
          },
          ...errors(400),
        },
      }),
      validator(
        "form",
        z.object({
          file: z.any(),
          context: z.string().optional(),
          language: z.string().optional(),
        }),
      ),
      async (c) => {
        try {
          const { file, context, language } = c.req.valid("form")
          if (!(file instanceof File)) return c.json({ message: "Missing file field" }, 400)
          if (file.size > MAX_AUDIO_BYTES) {
            return c.json({ message: `Audio too large: ${file.size} bytes (max ${MAX_AUDIO_BYTES})` }, 400)
          }
          const data = new Uint8Array(await file.arrayBuffer())
          if (data.byteLength === 0) return c.json({ message: "Empty audio recording" }, 400)
          if (!isAudioLike(file)) {
            return c.json({ message: `Not an audio file: ${file.type || file.name}` }, 400)
          }

          const result = await Voice.transcribe({ data, context, language, abortSignal: c.req.raw.signal })
          return c.json(result)
        } catch (err) {
          if (err instanceof VoiceNotConfiguredError) {
            return c.json({ message: err.message, reason: "voice_stt_not_configured" }, 400)
          }
          // STT providers return an empty transcript (200 with no text) when no
          // speech is detected; the AI SDK surfaces that as NoTranscriptGenerated.
          // Translate it into an actionable reason instead of the raw SDK error.
          if (err instanceof Error && err.name === "AI_NoTranscriptGeneratedError") {
            return c.json(
              {
                message: "No speech was detected in the recording. Move closer to the microphone and try again.",
                reason: "voice_no_speech",
              },
              400,
            )
          }
          return c.json(
            { message: err instanceof Error ? err.message : String(err), reason: "voice_transcription_failed" },
            400,
          )
        }
      },
    )
    .post(
      "/preview",
      describeRoute({
        summary: "Preview speech",
        description:
          "Synthesize up to 200 characters using the saved speech configuration and standard call recording.",
        operationId: "voice.preview",
        responses: {
          200: {
            description: "Synthesized audio",
            content: {
              "audio/wav": { schema: { type: "string", format: "binary" } },
              "audio/mpeg": { schema: { type: "string", format: "binary" } },
            },
          },
          ...errors(400),
        },
      }),
      validator("json", PreviewInput),
      async (c) => {
        try {
          const result = await Voice.speak({ ...c.req.valid("json"), abortSignal: c.req.raw.signal })
          return new Response(new Uint8Array(result.data).buffer, {
            headers: { "Content-Type": result.mimeType, "Cache-Control": "no-store" },
          })
        } catch (error) {
          return c.json(
            {
              message: error instanceof Error ? error.message : String(error),
              reason: error instanceof VoiceNotConfiguredError ? "voice_tts_not_configured" : "voice_preview_failed",
            },
            400,
          )
        }
      },
    )
