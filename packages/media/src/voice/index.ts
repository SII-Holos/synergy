import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { ProviderPricing } from "@ericsanchezok/synergy-harness/provider/pricing"
import { experimental_generateSpeech as generateSpeech, experimental_transcribe as transcribeAudio } from "ai"
import { createOpenAI } from "@ai-sdk/openai"
import { Config } from "@ericsanchezok/synergy-harness/config/config"
import { peakNormalizeWavPcm16 } from "./wav-loudness"
import { RolloutOperation } from "@ericsanchezok/synergy-harness/session/rollout/operation"
import { RolloutTransport } from "@ericsanchezok/synergy-harness/session/rollout/transport"
import { RolloutArtifact } from "@ericsanchezok/synergy-harness/session/rollout/artifact"
import { RolloutContext } from "@ericsanchezok/synergy-harness/session/rollout/context"
import { findRecordingError } from "@ericsanchezok/synergy-harness/session/rollout/error"
import { voiceCapabilityEnabled } from "../config-schema"
const DEFAULT_BASE_URL = "https://api.openai.com/v1"

type ClientFactory = typeof createOpenAI
const runtimeState = RuntimeContext.state(() => ({
  clientFactory: createOpenAI as ClientFactory,
}))

export class VoiceNotConfiguredError extends Error {
  constructor(side: "stt" | "tts") {
    super(
      side === "stt"
        ? "Voice input is unavailable. Enable it and select a speech recognition model in Settings → Voice."
        : "Read aloud is unavailable. Enable it and select a speech model in Settings → Voice.",
    )
    this.name = "VoiceNotConfiguredError"
  }
}

export namespace Voice {
  export function setClientFactoryForTest(factory: ClientFactory) {
    const instanceState = runtimeState()

    instanceState.clientFactory = factory
  }

  export function resetClientFactoryForTest() {
    const instanceState = runtimeState()

    instanceState.clientFactory = createOpenAI
  }

  export async function sttEnabled(): Promise<boolean> {
    const config = await Config.current()
    return voiceCapabilityEnabled(config.voice?.stt)
  }

  export async function ttsEnabled(): Promise<boolean> {
    const config = await Config.current()
    return voiceCapabilityEnabled(config.voice?.tts)
  }

  export async function transcribe(input: {
    data: Uint8Array
    context?: string
    language?: string
    abortSignal?: AbortSignal
  }): Promise<{ text: string }> {
    const instanceState = runtimeState()

    const config = await Config.current()
    const stt = config.voice?.stt
    if (!stt?.model || !voiceCapabilityEnabled(stt)) throw new VoiceNotConfiguredError("stt")

    const signal = AbortSignal.any(
      [input.abortSignal, RolloutContext.current()?.signal].filter((signal): signal is AbortSignal => !!signal),
    )
    const client = instanceState.clientFactory({
      baseURL: stt.baseURL ?? DEFAULT_BASE_URL,
      apiKey: stt.apiKey ?? undefined,
      fetch: RolloutTransport.sdkFetch,
    })
    const model = client.transcription(stt.model)
    const language = input.language ?? stt.language
    const prompt = input.context?.slice(0, 1000)

    // Microphone recordings are frequently mastered far below full scale and
    // STT voice-activity detection treats very quiet clips as silence. WAV
    // input is peak-normalized before transcription so real speech is heard;
    // other containers pass through untouched.
    const normalizedAudio = peakNormalizeWavPcm16(input.data)
    return RolloutOperation.execute(
      {
        purpose: "voice.transcribe",
        kind: "transcription",
        model: {
          providerID: "voice",
          modelID: stt.model,
          billingMode: stt.billingMode ?? "unknown",
          sdk: "@ai-sdk/openai",
          pricing: ProviderPricing.resolve({
            providerID: "voice",
            modelID: stt.model,
            cost: stt.cost,
            source: "configuration",
          }),
        },
        request: async (owner) => ({
          audio: await RolloutArtifact.write(
            owner,
            (async function* () {
              yield input.data
            })(),
            "application/octet-stream",
          ),
          prompt: prompt ?? null,
          language: language ?? null,
        }),
      },
      async () => {
        const result = await transcribeAudio({
          model,
          audio: normalizedAudio,
          abortSignal: signal,
          ...(prompt || language
            ? { providerOptions: { openai: { ...(prompt ? { prompt } : {}), ...(language ? { language } : {}) } } }
            : {}),
        })
        return {
          value: { text: result.text },
          response: JSON.parse(
            JSON.stringify({
              text: result.text,
              segments: result.segments,
              durationInSeconds: result.durationInSeconds,
              language: result.language,
            }),
          ),
        }
      },
    )
  }

  export async function speak(input: {
    text: string
    voice?: string
    instructions?: string
    abortSignal?: AbortSignal
  }): Promise<{ data: Uint8Array; mimeType: string }> {
    const instanceState = runtimeState()

    const config = await Config.current()
    const tts = config.voice?.tts
    if (!tts?.model || !voiceCapabilityEnabled(tts)) throw new VoiceNotConfiguredError("tts")

    const signal = AbortSignal.any(
      [input.abortSignal, RolloutContext.current()?.signal].filter((signal): signal is AbortSignal => !!signal),
    )
    const client = instanceState.clientFactory({
      baseURL: tts.baseURL ?? DEFAULT_BASE_URL,
      apiKey: tts.apiKey ?? undefined,
      fetch: RolloutTransport.sdkFetch,
    })
    const model = client.speech(tts.model)
    const voice = input.voice ?? tts.voice ?? undefined
    const instructions = input.instructions ?? tts.instructions ?? undefined

    // Request uncompressed PCM16 WAV so the clip can be peak-normalized in
    // pure JS before storage: TTS providers master well below full scale and
    // users hear the result as unexpectedly quiet. Providers that only serve
    // mp3 fall back without normalization rather than failing the call.
    return RolloutOperation.execute(
      {
        purpose: "voice.speak",
        kind: "speech",
        model: {
          providerID: "voice",
          modelID: tts.model,
          billingMode: tts.billingMode ?? "unknown",
          sdk: "@ai-sdk/openai",
          pricing: ProviderPricing.resolve({
            providerID: "voice",
            modelID: tts.model,
            cost: tts.cost,
            source: "configuration",
          }),
        },
        request: {
          text: input.text,
          voice: input.voice ?? tts.voice ?? null,
          instructions: input.instructions ?? tts.instructions ?? null,
        },
      },
      async () => {
        async function generate(outputFormat: "wav" | "mp3") {
          const result = await generateSpeech({
            model,
            text: input.text,
            voice,
            instructions,
            outputFormat,
            abortSignal: signal,
          })
          const owner = RolloutContext.current()!.owner
          const audio = await RolloutArtifact.write(
            owner,
            (async function* () {
              yield result.audio.uint8Array
            })(),
            result.audio.mediaType,
          )
          return {
            value: {
              data: outputFormat === "wav" ? peakNormalizeWavPcm16(result.audio.uint8Array) : result.audio.uint8Array,
              mimeType: outputFormat === "wav" ? "audio/wav" : "audio/mpeg",
            },
            response: { audio, outputFormat },
          }
        }
        try {
          return await generate("wav")
        } catch (wavError) {
          const recordingError = findRecordingError(wavError)
          if (recordingError) throw recordingError
          if (signal.aborted) throw wavError
          return generate("mp3")
        }
      },
    )
  }
}
