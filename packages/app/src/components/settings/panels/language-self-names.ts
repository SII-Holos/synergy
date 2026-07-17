import type { ActiveLocale } from "@/context/locale"

export const LANGUAGE_SELF_NAMES = {
  en: "English",
  "zh-CN": "简体中文",
} as const satisfies Readonly<Record<ActiveLocale, string>>
