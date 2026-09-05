import { experimental_generateSpeech as generateSpeech, experimental_transcribe as transcribeAudio } from "ai"
import { createOpenAI } from "@ai-sdk/openai"
import { Config } from "../config/config"
import { peakNormalizeWavPcm16 } from "./wav-loudness"
const DEFAULT_BASE_URL = "https://api.openai.com/v1"

type ClientFactory = typeof createOpenAI
let clientFactory: ClientFactory = createOpenAI

export class VoiceNotConfiguredError extends Error {
  constructor(side: "stt" | "tts") {
    super(
      side === "stt"
        ? "Voice dictation is disabled: voice.stt.model is not configured. Set it in Settings → Voice (config domain voice, file 125-voice.jsonc)."
        : "Speech synthesis is disabled: voice.tts.model is not configured. Set it in Settings → Voice (config domain voice, file 125-voice.jsonc).",
    )
    this.name = "VoiceNotConfiguredError"
  }
}

export namespace Voice {
  export function setClientFactoryForTest(factory: ClientFactory) {
    clientFactory = factory
  }

  export function resetClientFactoryForTest() {
    clientFactory = createOpenAI
  }

  export async function sttEnabled(): Promise<boolean> {
    const config = await Config.current()
    return Boolean(config.voice?.stt?.model)
  }

  export async function ttsEnabled(): Promise<boolean> {
    const config = await Config.current()
    return Boolean(config.voice?.tts?.model)
  }

  export async function transcribe(input: {
    data: Uint8Array
    context?: string
    language?: string
    abortSignal?: AbortSignal
  }): Promise<{ text: string }> {
    const config = await Config.current()
    const stt = config.voice?.stt
    if (!stt?.model) throw new VoiceNotConfiguredError("stt")

    const client = clientFactory({ baseURL: stt.baseURL ?? DEFAULT_BASE_URL, apiKey: stt.apiKey })
    const language = input.language ?? stt.language
    const prompt = input.context?.slice(0, 1000)

    // Microphone recordings are frequently mastered far below full scale and
    // STT voice-activity detection treats very quiet clips as silence. WAV
    // input is peak-normalized before transcription so real speech is heard;
    // other containers pass through untouched.
    const normalizedAudio = peakNormalizeWavPcm16(input.data)
    const result = await transcribeAudio({
      model: client.transcription(stt.model),
      audio: normalizedAudio,
      abortSignal: input.abortSignal,
      ...(prompt || language
        ? { providerOptions: { openai: { ...(prompt ? { prompt } : {}), ...(language ? { language } : {}) } } }
        : {}),
    })
    return { text: result.text }
  }

  export async function speak(input: {
    text: string
    voice?: string
    instructions?: string
    abortSignal?: AbortSignal
  }): Promise<{ data: Uint8Array; mimeType: string }> {
    const config = await Config.current()
    const tts = config.voice?.tts
    if (!tts?.model) throw new VoiceNotConfiguredError("tts")

    const client = clientFactory({ baseURL: tts.baseURL ?? DEFAULT_BASE_URL, apiKey: tts.apiKey })

    // Request uncompressed PCM16 WAV so the clip can be peak-normalized in
    // pure JS before storage: TTS providers master well below full scale and
    // users hear the result as unexpectedly quiet. Providers that only serve
    // mp3 fall back without normalization rather than failing the call.
    try {
      const result = await generateSpeech({
        model: client.speech(tts.model),
        text: input.text,
        voice: input.voice ?? tts.voice,
        instructions: input.instructions ?? tts.instructions,
        outputFormat: "wav",
        abortSignal: input.abortSignal,
      })
      return { data: peakNormalizeWavPcm16(result.audio.uint8Array), mimeType: "audio/wav" }
    } catch (wavError) {
      const result = await generateSpeech({
        model: client.speech(tts.model),
        text: input.text,
        voice: input.voice ?? tts.voice,
        instructions: input.instructions ?? tts.instructions,
        outputFormat: "mp3",
        abortSignal: input.abortSignal,
      })
      return { data: result.audio.uint8Array, mimeType: "audio/mpeg" }
    }
  }
}
