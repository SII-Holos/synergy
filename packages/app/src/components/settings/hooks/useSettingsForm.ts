import type { Config } from "@ericsanchezok/synergy-sdk/client"
import type { SetStoreFunction } from "solid-js/store"
import type { SendShortcut } from "@/context/input"
import type { SettingsState } from "../types"
import { MODEL_DEFAULTS, TOAST_TYPES, UI_DEFAULTS, emptyToastDurationOverrides, resolvePermissionForUi } from "../types"

export type EnsureInitParams = {
  cfg: Config | undefined
  setName: string | undefined
  refreshing: () => boolean
  initialized: () => boolean
  initializedForSet: string | undefined
  sendShortcut: () => SendShortcut
  setSettings: SetStoreFunction<SettingsState>
  setInitialized: (value: boolean) => void
  originalMcpsRef: { current: Record<string, Record<string, unknown>> }
}

export function ensureInit(params: EnsureInitParams): string | undefined {
  if (params.refreshing()) return undefined
  const cfg = params.cfg
  const setName = params.setName
  if (!cfg || !setName) return undefined
  if (params.initialized() && params.initializedForSet === setName) return undefined

  params.setSettings("general", {
    snapshot: cfg.snapshot ?? UI_DEFAULTS.snapshot,
    autoupdate: String(cfg.autoupdate ?? UI_DEFAULTS.autoupdate),
    username: cfg.username ?? UI_DEFAULTS.username,
    theme: cfg.theme ?? UI_DEFAULTS.theme,
    mutedToasts: cfg.toast?.muted ?? [],
    toastDurations: formatToastDurations(cfg.toast?.durationOverrides),
    sendShortcut: params.sendShortcut(),
  })

  params.setSettings("models", {
    model: cfg.model ?? MODEL_DEFAULTS.model,
    nano_model: cfg.nano_model ?? MODEL_DEFAULTS.nano_model,
    mini_model: cfg.mini_model ?? MODEL_DEFAULTS.mini_model,
    mid_model: cfg.mid_model ?? MODEL_DEFAULTS.mid_model,
    vision_model: cfg.vision_model ?? MODEL_DEFAULTS.vision_model,
    thinking_model: cfg.thinking_model ?? MODEL_DEFAULTS.thinking_model,
    long_context_model: cfg.long_context_model ?? MODEL_DEFAULTS.long_context_model,
    creative_model: cfg.creative_model ?? MODEL_DEFAULTS.creative_model,
  })

  params.setSettings("providers", {
    enabledProviders: formatList(cfg.enabled_providers),
    disabledProviders: formatList(cfg.disabled_providers),
  })

  params.setSettings("plugins", {
    entries: (cfg.plugin ?? []).map((value) => ({ value })),
  })

  params.originalMcpsRef.current = {}
  if (cfg.mcp) {
    for (const [key, value] of Object.entries(cfg.mcp)) {
      params.originalMcpsRef.current[key] = { ...(value as Record<string, unknown>) }
    }
  }
  params.setSettings("mcps", {
    entries: cfg.mcp
      ? Object.entries(cfg.mcp).map(([key, value]) => {
          const mcp = value as Record<string, unknown>
          const isLocal = mcp.type === "local"
          const env = mcp.environment as Record<string, string> | undefined
          const headers = mcp.headers as Record<string, string> | undefined
          return {
            key,
            type: isLocal ? "local" : "remote",
            enabled: mcp.enabled !== false,
            command: isLocal && Array.isArray(mcp.command) ? (mcp.command as string[]).join(" ") : "",
            url: !isLocal && typeof mcp.url === "string" ? mcp.url : "",
            timeout: mcp.timeout !== undefined ? String(mcp.timeout) : "",
            environment: formatRecord(env, "="),
            headers: formatRecord(headers, ": "),
          }
        })
      : [],
  })

  params.setSettings("safety", {
    controlProfile: cfg.controlProfile ?? UI_DEFAULTS.controlProfile,
    permission: resolvePermissionForUi(cfg.permission),
    smartAllow: cfg.smartAllow === true ? "true" : "false",
    sandboxEnabled: cfg.sandbox?.enabled === false ? "false" : UI_DEFAULTS.sandboxEnabled,
    sandboxFallbackPolicy: cfg.sandbox?.fallbackPolicy ?? UI_DEFAULTS.sandboxFallbackPolicy,
  })

  params.setSettings("runtime", {
    questionTimeout: String(cfg.question?.timeout ?? UI_DEFAULTS.questionTimeout),
    compactionAuto: cfg.compaction?.auto !== false ? UI_DEFAULTS.compactionAuto : "false",
    compactionPrune: cfg.compaction?.prune !== false ? UI_DEFAULTS.compactionPrune : "false",
    compactionOverflowThreshold: String(
      cfg.compaction?.overflowThreshold ?? Number(UI_DEFAULTS.compactionOverflowThreshold),
    ),
    compactionMaxHistoryImages: String(
      cfg.compaction?.maxHistoryImages ?? Number(UI_DEFAULTS.compactionMaxHistoryImages),
    ),
    invokeTimeout: cfg.timeout?.invoke_sec !== undefined ? String(cfg.timeout.invoke_sec) : UI_DEFAULTS.invokeTimeout,
    providerTtfbTimeout:
      cfg.timeout?.provider?.ttfb_sec !== undefined
        ? String(cfg.timeout.provider.ttfb_sec)
        : UI_DEFAULTS.providerTtfbTimeout,
    providerIdleTimeout:
      cfg.timeout?.provider?.idle_sec !== undefined
        ? String(cfg.timeout.provider.idle_sec)
        : UI_DEFAULTS.providerIdleTimeout,
    providerWallTimeout:
      cfg.timeout?.provider?.wall_sec !== undefined
        ? String(cfg.timeout.provider.wall_sec)
        : UI_DEFAULTS.providerWallTimeout,
    toolDefaultTimeout:
      cfg.timeout?.tool?.default_sec !== undefined
        ? String(cfg.timeout.tool.default_sec)
        : UI_DEFAULTS.toolDefaultTimeout,
    toolOverrides: formatRecord(cfg.timeout?.tool?.overrides),
    watcherIgnore: formatList(cfg.watcher?.ignore),
    logLevel: cfg.logLevel ?? UI_DEFAULTS.logLevel,
  })

  params.setSettings("email", {
    enabled: cfg.email?.enabled ?? true,
    fromAddress: cfg.email?.from?.address ?? "",
    fromName: cfg.email?.from?.name ?? "",
    smtpHost: cfg.email?.smtp?.host ?? "",
    smtpPort: cfg.email?.smtp?.port !== undefined ? String(cfg.email.smtp.port) : "",
    smtpSecure: cfg.email?.smtp?.secure ?? true,
    smtpUsername: cfg.email?.smtp?.username ?? "",
    smtpPassword: cfg.email?.smtp?.password ?? "",
    imapHost: cfg.email?.imap?.host ?? "",
    imapPort: cfg.email?.imap?.port !== undefined ? String(cfg.email.imap.port) : "",
    imapSecure: cfg.email?.imap?.secure ?? true,
    imapUsername: cfg.email?.imap?.username ?? "",
    imapPassword: cfg.email?.imap?.password ?? "",
  })

  params.setSettings("channels", {
    feishuAccounts: cfg.channel?.feishu?.accounts
      ? Object.entries(cfg.channel.feishu.accounts).map(([key, account]) => ({
          key,
          enabled: account.enabled !== false,
        }))
      : [],
  })

  const library = cfg.library
  const memory = library?.memory
  const experience = library?.experience
  const memoryRetrieve = typeof memory?.retrieval === "object" ? memory.retrieval : undefined
  const experienceRetrieve = typeof experience?.retrieve === "object" ? experience.retrieve : undefined
  params.setSettings("library", {
    learning:
      memory?.enabled === false && experience?.encode === false && experience?.retrieve === false ? "false" : "true",
    autonomy: library?.autonomy === undefined ? UI_DEFAULTS.libraryAutonomy : library.autonomy ? "true" : "false",
    memorySimThreshold:
      memoryRetrieve?.simThreshold !== undefined ? String(memoryRetrieve.simThreshold) : UI_DEFAULTS.memorySimThreshold,
    memoryTopK: memoryRetrieve?.topK !== undefined ? String(memoryRetrieve.topK) : UI_DEFAULTS.memoryTopK,
    experienceSimThreshold:
      experienceRetrieve?.simThreshold !== undefined
        ? String(experienceRetrieve.simThreshold)
        : UI_DEFAULTS.experienceSimThreshold,
    experienceTopK:
      experienceRetrieve?.topK !== undefined ? String(experienceRetrieve.topK) : UI_DEFAULTS.experienceTopK,
    experienceEpsilon:
      experienceRetrieve?.epsilon !== undefined ? String(experienceRetrieve.epsilon) : UI_DEFAULTS.experienceEpsilon,
  })

  params.setInitialized(true)
  return setName
}

function formatList(values: string[] | undefined): string {
  return values?.join("\n") ?? ""
}

function formatRecord(values: Record<string, string | number> | undefined, separator = "="): string {
  return values
    ? Object.entries(values)
        .map(([key, value]) => `${key}${separator}${value}`)
        .join("\n")
    : ""
}

function formatToastDurations(values: Record<string, number> | undefined) {
  const result = emptyToastDurationOverrides()
  if (!values) return result
  for (const type of TOAST_TYPES) {
    const value = values[type]
    if (typeof value === "number") result[type] = String(value)
  }
  return result
}
