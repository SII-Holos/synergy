import { ConfigDomain } from "@ericsanchezok/synergy-harness/config/domain"
import z from "zod"
import { ProviderPricing } from "@ericsanchezok/synergy-harness/provider/pricing"
import { ConfigExtensions } from "@ericsanchezok/synergy-harness/config/extensions"
export const VoiceSttConfig = z
  .object({
    cost: ProviderPricing.Cost.optional().describe(
      "Explicit model prices in USD: token rates per million, unit rates per declared quantity",
    ),
    baseURL: z.string().optional().describe("Base URL for the speech-to-text API (OpenAI-compatible)"),
    apiKey: z.string().optional().describe("API key for the speech-to-text service"),
    model: z.string().optional().describe("Speech-to-text model name. Voice input is disabled when not set."),
    language: z
      .string()
      .optional()
      .describe("BCP-47 language hint for transcription, e.g. zh, en. Auto-detected when not set."),
  })
  .strict()
  .meta({ ref: "VoiceSttConfig" })
  .describe("Speech-to-text service for composer voice dictation. Disabled when model is not set.")

export type VoiceSttConfig = z.infer<typeof VoiceSttConfig>

export const VoiceTtsConfig = z
  .object({
    cost: ProviderPricing.Cost.optional().describe(
      "Explicit model prices in USD: token rates per million, unit rates per declared quantity",
    ),
    baseURL: z.string().optional().describe("Base URL for the text-to-speech API (OpenAI-compatible)"),
    apiKey: z.string().optional().describe("API key for the text-to-speech service"),
    model: z.string().optional().describe("Text-to-speech model name. The speak tool is disabled when not set."),
    voice: z.string().optional().describe("Voice name for synthesis (provider-specific, e.g. alloy)"),
    instructions: z
      .string()
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

export function registerConfig() {
  ConfigExtensions.register("media", { shape: ConfigShape })
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
registerConfig()

export async function readConfig(): Promise<ConfigValues> {
  const { Config } = await import("@ericsanchezok/synergy-harness/config/config")
  return Config.current()
}
