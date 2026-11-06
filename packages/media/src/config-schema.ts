import { ConfigDomain } from "@ericsanchezok/synergy-harness/config/domain"
import { z } from "zod"
import { ProviderPricing } from "@ericsanchezok/synergy-harness/provider/pricing"
import { ConfigExtensions } from "@ericsanchezok/synergy-harness/config/extensions"
export const VoiceSttConfig = z
  .object({
    enabled: z.boolean().optional().describe("Enable voice input. When omitted, a configured model enables it."),
    billingMode: ProviderPricing.BillingMode.optional(),
    cost: ProviderPricing.Cost.optional().describe(
      "Explicit model prices in USD: token rates per million, unit rates per declared quantity",
    ),
    baseURL: z
      .string()
      .nullable()
      .optional()
      .describe("OpenAI-compatible endpoint. Null restores the default endpoint."),
    apiKey: z.string().nullable().optional().describe("Speech-to-text credential. Null removes the credential."),
    model: z.string().optional().describe("Speech-to-text model name. Voice input is disabled when not set."),
    language: z
      .string()
      .nullable()
      .optional()
      .describe("BCP-47 language hint for transcription, e.g. zh, en. Auto-detected when not set."),
  })
  .strict()
  .meta({ ref: "VoiceSttConfig" })
  .describe("Speech-to-text service for composer voice dictation. Disabled when model is not set.")

export type VoiceSttConfig = z.infer<typeof VoiceSttConfig>

export const VoiceTtsConfig = z
  .object({
    enabled: z.boolean().optional().describe("Enable speech output. When omitted, a configured model enables it."),
    billingMode: ProviderPricing.BillingMode.optional(),
    cost: ProviderPricing.Cost.optional().describe(
      "Explicit model prices in USD: token rates per million, unit rates per declared quantity",
    ),
    baseURL: z
      .string()
      .nullable()
      .optional()
      .describe("OpenAI-compatible endpoint. Null restores the default endpoint."),
    apiKey: z.string().nullable().optional().describe("Text-to-speech credential. Null removes the credential."),
    model: z.string().optional().describe("Text-to-speech model name. The speak tool is disabled when not set."),
    voice: z.string().nullable().optional().describe("Voice name for synthesis. Null restores the service default."),
    instructions: z
      .string()
      .nullable()
      .optional()
      .describe("Natural-language delivery instructions applied to synthesized speech, e.g. tone and pace"),
  })
  .strict()
  .meta({ ref: "VoiceTtsConfig" })
  .describe("Text-to-speech service backing the speak tool. Disabled when model is not set.")

export type VoiceTtsConfig = z.infer<typeof VoiceTtsConfig>

export const VoiceConfig = z
  .object({
    stt: VoiceSttConfig.optional().describe("Speech-to-text service configuration"),
    tts: VoiceTtsConfig.optional().describe("Text-to-speech service configuration"),
  })
  .strict()
  .optional()
  .meta({ ref: "VoiceConfig" })
  .describe("Voice input (dictation) and output (speech synthesis) configuration.")

export type VoiceConfig = z.infer<typeof VoiceConfig>

export const ConfigShape = {
  voice: VoiceConfig,
}

export type ConfigValues = z.output<z.ZodObject<typeof ConfigShape>>

declare module "@ericsanchezok/synergy-harness/config/schema" {
  interface ConfigExtensionShape extends ConfigShapeType {}
}
type ConfigShapeType = typeof ConfigShape

export function voiceCapabilityEnabled(side: { enabled?: boolean; model?: string } | undefined): boolean {
  return side?.enabled !== false && Boolean(side?.model?.trim())
}

const contribution: ConfigExtensions.Contribution = {
  shape: ConfigShape,
  normalize(raw) {
    const config = raw as ConfigValues
    for (const side of [config.voice?.stt, config.voice?.tts]) {
      if (!side) continue
      for (const key of ["baseURL", "apiKey"] as const) if (side[key] === null) delete side[key]
    }
    if (config.voice?.stt?.language === null) delete config.voice.stt.language
    for (const key of ["voice", "instructions"] as const) {
      if (config.voice?.tts?.[key] === null) delete config.voice.tts[key]
    }
  },
  redact(raw, helpers) {
    const config = raw as ConfigValues
    for (const side of [config.voice?.stt, config.voice?.tts]) {
      if (side?.apiKey) side.apiKey = helpers.sentinel
    }
  },
  restore(raw, previous, helpers) {
    const config = raw as ConfigValues
    const stored = previous as ConfigValues | undefined
    for (const key of ["stt", "tts"] as const) {
      const side = config.voice?.[key]
      if (side?.apiKey !== helpers.sentinel) continue
      if (stored?.voice?.[key]?.apiKey) side.apiKey = stored.voice[key]!.apiKey
      else delete side.apiKey
    }
  },
}

export function registerConfig() {
  ConfigExtensions.register("media", contribution)
  for (const domain of [
    {
      id: "voice",
      filename: "125-voice.jsonc",
      label: "Voice",
      ownedKeys: ["voice"],
      mergePolicy: "merge",
      reloadTargets: ["config"],
      uiSection: "voice",
      importable: true,
    },
  ] satisfies ConfigDomain.Definition[])
    ConfigDomain.register(domain)
}

export async function readConfig(): Promise<ConfigValues> {
  const { Config } = await import("@ericsanchezok/synergy-harness/config/config")
  return Config.current()
}
