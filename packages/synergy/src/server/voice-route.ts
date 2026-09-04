import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import z from "zod"
import { errors } from "./error"
import { Voice, VoiceNotConfiguredError } from "../voice"

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

export const VoiceRoute = new Hono().post(
  "/transcribe",
  describeRoute({
    summary: "Transcribe audio",
    description:
      "Transcribe a short audio recording to text for composer voice dictation. Audio is processed in memory and never persisted.",
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

      const result = await Voice.transcribe({ data, context, language })
      return c.json(result)
    } catch (err: any) {
      if (err instanceof VoiceNotConfiguredError) {
        return c.json({ message: err.message, reason: "voice_stt_not_configured" }, 400)
      }
      return c.json({ message: err?.message ?? String(err) }, 400)
    }
  },
)
