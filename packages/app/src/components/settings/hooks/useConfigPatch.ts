import type { Config } from "@ericsanchezok/synergy-sdk/client"
import { MODEL_ROLES, TOAST_TYPES, UI_DEFAULTS, resolvePermissionForUi, snapToastDuration } from "../types"
import type { SettingsState } from "../types"

export type BuildPatchParams = {
  cfg: Config
  state: SettingsState
  originalMcps: Record<string, Record<string, unknown>>
}

export function buildPatch(params: BuildPatchParams): Record<string, unknown> {
  const { cfg, state, originalMcps } = params
  const patch: Record<string, unknown> = {}

  buildGeneralPatch(cfg, state, patch)
  buildModelPatch(cfg, state, patch)
  buildProviderPatch(cfg, state, patch)
  buildPluginPatch(cfg, state, patch)
  buildMcpPatch(cfg, state, originalMcps, patch)
  buildSafetyPatch(cfg, state, patch)
  buildRuntimePatch(cfg, state, patch)
  buildEmailPatch(cfg, state, patch)
  buildChannelPatch(cfg, state, patch)
  buildLibraryPatch(cfg, state, patch)

  return patch
}

function buildGeneralPatch(cfg: Config, state: SettingsState, patch: Record<string, unknown>) {
  const { general } = state
  if (general.snapshot !== (cfg.snapshot ?? UI_DEFAULTS.snapshot)) patch.snapshot = general.snapshot

  const username = general.username.trim()
  if (username !== (cfg.username ?? UI_DEFAULTS.username)) patch.username = username || undefined

  const theme = general.theme.trim()
  if (theme !== (cfg.theme ?? UI_DEFAULTS.theme)) patch.theme = theme || undefined

  const toast = buildToastPatch(general.mutedToasts, general.toastDurations)
  if (JSON.stringify(toast) !== JSON.stringify(cfg.toast ?? {})) {
    patch.toast = Object.keys(toast).length ? toast : undefined
  }
}

function buildModelPatch(cfg: Config, state: SettingsState, patch: Record<string, unknown>) {
  for (const role of MODEL_ROLES) {
    const origVal = (cfg[role.key as keyof Config] as string | undefined) ?? ""
    const newVal = state.models[role.key]
    if (newVal !== origVal) patch[role.key] = newVal || undefined
  }
  const origVariant = cfg.role_variant
  const variants = state.roleVariant
  const cleanedVariant: Record<string, string> = {}
  for (const [role, variant] of Object.entries(variants)) {
    if (variant) cleanedVariant[role] = variant
  }
  if (JSON.stringify(cleanedVariant) !== JSON.stringify(origVariant ?? {})) {
    patch.role_variant = Object.keys(cleanedVariant).length ? cleanedVariant : undefined
  }
}

function buildProviderPatch(cfg: Config, state: SettingsState, patch: Record<string, unknown>) {
  const enabled = parseList(state.providers.enabledProviders)
  const disabled = parseList(state.providers.disabledProviders)
  if (JSON.stringify(enabled) !== JSON.stringify(cfg.enabled_providers ?? [])) {
    patch.enabled_providers = enabled.length ? enabled : undefined
  }
  if (JSON.stringify(disabled) !== JSON.stringify(cfg.disabled_providers ?? [])) {
    patch.disabled_providers = disabled.length ? disabled : undefined
  }
}

function buildPluginPatch(cfg: Config, state: SettingsState, patch: Record<string, unknown>) {
  const newPlugin = state.plugins.entries.map((entry) => entry.value.trim()).filter(Boolean)
  if (JSON.stringify(newPlugin) !== JSON.stringify(cfg.plugin ?? [])) patch.plugin = newPlugin
}

function buildMcpPatch(
  cfg: Config,
  state: SettingsState,
  originalMcps: Record<string, Record<string, unknown>>,
  patch: Record<string, unknown>,
) {
  const newMcp: Record<string, Record<string, unknown>> = {}
  for (const entry of state.mcps.entries) {
    if (!entry.key.trim()) continue
    const key = entry.key.trim()
    const base = { ...(originalMcps[key] ?? {}) }

    base.type = entry.type
    base.enabled = entry.enabled

    if (entry.type === "local") {
      const parts = entry.command.trim().split(/\s+/).filter(Boolean)
      if (parts.length) base.command = parts
      else delete base.command
      delete base.url
      const environment = parseKeyValueLines(entry.environment, "=")
      if (Object.keys(environment).length) base.environment = environment
      else delete base.environment
      delete base.headers
    } else {
      const url = entry.url.trim()
      if (url) base.url = url
      else delete base.url
      delete base.command
      const headers = parseKeyValueLines(entry.headers, ":")
      if (Object.keys(headers).length) base.headers = headers
      else delete base.headers
      delete base.environment
    }

    const timeout = positiveNumber(entry.timeout)
    if (timeout !== undefined) base.timeout = timeout
    else delete base.timeout

    newMcp[key] = base
  }

  if (JSON.stringify(newMcp) !== JSON.stringify(cfg.mcp ?? {})) patch.mcp = newMcp
}

function buildSafetyPatch(cfg: Config, state: SettingsState, patch: Record<string, unknown>) {
  const { safety } = state
  if (safety.controlProfile !== (cfg.controlProfile ?? UI_DEFAULTS.controlProfile)) {
    patch.controlProfile = safety.controlProfile
  }

  if (safety.permission !== resolvePermissionForUi(cfg.permission)) {
    patch.permission = safety.permission || undefined
  }

  const smartAllow = safety.smartAllow === "true"
  if (smartAllow !== (cfg.smartAllow === true)) patch.smartAllow = smartAllow

  const sandbox: Record<string, unknown> = {}
  const sandboxEnabled = safety.sandboxEnabled === "true"
  const currentEnabled = cfg.sandbox?.enabled !== false
  if (sandboxEnabled !== currentEnabled || cfg.sandbox?.enabled !== undefined) sandbox.enabled = sandboxEnabled
  if (safety.sandboxFallbackPolicy !== (cfg.sandbox?.fallbackPolicy ?? UI_DEFAULTS.sandboxFallbackPolicy)) {
    sandbox.fallbackPolicy = safety.sandboxFallbackPolicy
  }
  if (Object.keys(sandbox).length) {
    patch.sandbox = { ...(cfg.sandbox ?? {}), ...sandbox }
  }
}

function buildRuntimePatch(cfg: Config, state: SettingsState, patch: Record<string, unknown>) {
  const { runtime } = state

  const questionTimeout = nonNegativeNumber(runtime.questionTimeout)
  if (questionTimeout !== undefined && questionTimeout !== (cfg.question?.timeout ?? UI_DEFAULTS.questionTimeout)) {
    patch.question = { ...(cfg.question ?? {}), timeout: questionTimeout }
  }

  const compaction = {
    auto: runtime.compactionAuto === "true",
    prune: runtime.compactionPrune === "true",
    overflowThreshold: boundedNumber(runtime.compactionOverflowThreshold, 0.5, 1),
    maxHistoryImages: nonNegativeInteger(runtime.compactionMaxHistoryImages),
  }
  const currentCompaction = {
    auto: cfg.compaction?.auto !== false,
    prune: cfg.compaction?.prune !== false,
    overflowThreshold: cfg.compaction?.overflowThreshold ?? Number(UI_DEFAULTS.compactionOverflowThreshold),
    maxHistoryImages: cfg.compaction?.maxHistoryImages ?? Number(UI_DEFAULTS.compactionMaxHistoryImages),
  }
  if (
    compaction.overflowThreshold !== undefined &&
    compaction.maxHistoryImages !== undefined &&
    JSON.stringify(compaction) !== JSON.stringify(currentCompaction)
  ) {
    patch.compaction = compaction
  }

  const timeout = buildTimeoutPatch(cfg, runtime)
  if (timeout.changed) patch.timeout = timeout.value

  const watcherIgnore = parseList(runtime.watcherIgnore)
  if (JSON.stringify(watcherIgnore) !== JSON.stringify(cfg.watcher?.ignore ?? [])) {
    patch.watcher = watcherIgnore.length ? { ...(cfg.watcher ?? {}), ignore: watcherIgnore } : undefined
  }

  const logLevel = runtime.logLevel.trim()
  if (logLevel !== (cfg.logLevel ?? UI_DEFAULTS.logLevel)) patch.logLevel = logLevel || undefined
}

function buildTimeoutPatch(cfg: Config, runtime: SettingsState["runtime"]) {
  const timeout: Record<string, unknown> = {}
  const invoke = positiveNumber(runtime.invokeTimeout)
  if (invoke !== undefined) timeout.invoke_sec = invoke

  const provider: Record<string, unknown> = {}
  const ttfb = positiveNumber(runtime.providerTtfbTimeout)
  const idle = nonNegativeNumber(runtime.providerIdleTimeout)
  const wall = nonNegativeNumber(runtime.providerWallTimeout)
  if (ttfb !== undefined) provider.ttfb_sec = ttfb
  if (idle !== undefined) provider.idle_sec = idle
  if (wall !== undefined) provider.wall_sec = wall
  if (Object.keys(provider).length) timeout.provider = provider

  const tool: Record<string, unknown> = {}
  const defaultTool = positiveNumber(runtime.toolDefaultTimeout)
  const overrides = parseNumericRecord(runtime.toolOverrides)
  if (defaultTool !== undefined) tool.default_sec = defaultTool
  if (Object.keys(overrides).length) tool.overrides = overrides
  if (Object.keys(tool).length) timeout.tool = tool

  const current = cfg.timeout ?? {}
  return {
    changed: JSON.stringify(timeout) !== JSON.stringify(current),
    value: Object.keys(timeout).length ? timeout : undefined,
  }
}

function buildEmailPatch(cfg: Config, state: SettingsState, patch: Record<string, unknown>) {
  const { email } = state
  const smtpPort = positiveInteger(email.smtpPort)
  const imapPort = positiveInteger(email.imapPort)
  const hasEmailFrom = Boolean(email.fromAddress.trim() || email.fromName.trim())
  const hasEmailSmtp = Boolean(
    email.smtpHost.trim() ||
      smtpPort !== undefined ||
      email.smtpUsername.trim() ||
      email.smtpPassword.trim() ||
      email.smtpSecure !== true,
  )
  const hasEmailImap = Boolean(
    email.imapHost.trim() ||
      imapPort !== undefined ||
      email.imapUsername.trim() ||
      email.imapPassword.trim() ||
      email.imapSecure !== true,
  )
  const shouldMaterializeEmail =
    hasEmailFrom || hasEmailSmtp || hasEmailImap || email.enabled !== true || cfg.email !== undefined
  const newEmail: Record<string, unknown> = {}

  if (shouldMaterializeEmail) {
    if (email.enabled !== true || cfg.email?.enabled !== undefined) newEmail.enabled = email.enabled
    if (hasEmailFrom) {
      newEmail.from = {
        ...(email.fromAddress.trim() ? { address: email.fromAddress.trim() } : {}),
        ...(email.fromName.trim() ? { name: email.fromName.trim() } : {}),
      }
    }
    if (hasEmailSmtp) {
      newEmail.smtp = {
        ...(email.smtpHost.trim() ? { host: email.smtpHost.trim() } : {}),
        ...(smtpPort !== undefined ? { port: smtpPort } : {}),
        secure: email.smtpSecure,
        ...(email.smtpUsername.trim() ? { username: email.smtpUsername.trim() } : {}),
        ...(email.smtpPassword.trim()
          ? { password: email.smtpPassword.trim() }
          : cfg.email?.smtp?.password
            ? { password: "__REDACTED__" }
            : {}),
      }
    }
    if (hasEmailImap) {
      newEmail.imap = {
        ...(email.imapHost.trim() ? { host: email.imapHost.trim() } : {}),
        ...(imapPort !== undefined ? { port: imapPort } : {}),
        secure: email.imapSecure,
        ...(email.imapUsername.trim() ? { username: email.imapUsername.trim() } : {}),
        ...(email.imapPassword.trim()
          ? { password: email.imapPassword.trim() }
          : cfg.email?.imap?.password
            ? { password: "__REDACTED__" }
            : {}),
      }
    }
  }

  if (JSON.stringify(newEmail) !== JSON.stringify(cfg.email ?? {})) {
    patch.email = Object.keys(newEmail).length > 0 ? newEmail : undefined
  }
}

function buildChannelPatch(cfg: Config, state: SettingsState, patch: Record<string, unknown>) {
  const currentChannel = cfg.channel ?? {}
  const newChannel = structuredClone(currentChannel) as NonNullable<Config["channel"]> | {}
  if ("feishu" in newChannel && newChannel.feishu?.accounts) {
    for (const entry of state.channels.feishuAccounts) {
      const account = newChannel.feishu.accounts[entry.key]
      if (!account) continue
      account.enabled = entry.enabled
      ;(account as Record<string, unknown>).model = entry.model || undefined
    }
  }
  if (JSON.stringify(newChannel) !== JSON.stringify(currentChannel)) patch.channel = newChannel
}

function buildLibraryPatch(cfg: Config, state: SettingsState, patch: Record<string, unknown>) {
  const library = state.library
  const origLibrary = cfg.library
  const origMemory = origLibrary?.memory
  const origExperience = origLibrary?.experience
  const origLearning =
    origMemory?.enabled === false && origExperience?.encode === false && origExperience?.retrieve === false
      ? "false"
      : "true"
  const origAutonomy = origLibrary?.autonomy !== undefined ? (origLibrary.autonomy ? "true" : "false") : "true"
  const origMemoryRetrieve = typeof origMemory?.retrieval === "object" ? origMemory.retrieval : undefined
  const origExperienceRetrieve = typeof origExperience?.retrieve === "object" ? origExperience.retrieve : undefined
  const origMemorySim = origMemoryRetrieve?.simThreshold !== undefined ? String(origMemoryRetrieve.simThreshold) : "0.7"
  const origMemoryTopK = origMemoryRetrieve?.topK !== undefined ? String(origMemoryRetrieve.topK) : "3"
  const origExperienceSim =
    origExperienceRetrieve?.simThreshold !== undefined ? String(origExperienceRetrieve.simThreshold) : "0.7"
  const origExperienceTopK = origExperienceRetrieve?.topK !== undefined ? String(origExperienceRetrieve.topK) : "8"
  const origExperienceEpsilon =
    origExperienceRetrieve?.epsilon !== undefined ? String(origExperienceRetrieve.epsilon) : "0.1"

  const changed =
    library.learning !== origLearning ||
    library.autonomy !== origAutonomy ||
    library.memorySimThreshold !== origMemorySim ||
    library.memoryTopK !== origMemoryTopK ||
    library.experienceSimThreshold !== origExperienceSim ||
    library.experienceTopK !== origExperienceTopK ||
    library.experienceEpsilon !== origExperienceEpsilon
  if (!changed) return

  const nextLibrary = structuredClone(origLibrary ?? {}) as Record<string, unknown>
  const learningBool = library.learning !== "false"
  const memoryRetrieve: Record<string, unknown> = {}
  const memorySim = Number(library.memorySimThreshold)
  const memoryTopK = positiveInteger(library.memoryTopK)
  if (!Number.isNaN(memorySim) && library.memorySimThreshold !== "0.7") memoryRetrieve.simThreshold = memorySim
  if (memoryTopK !== undefined && library.memoryTopK !== "3") memoryRetrieve.topK = memoryTopK
  nextLibrary.memory = {
    ...((nextLibrary.memory as Record<string, unknown> | undefined) ?? {}),
    enabled: learningBool,
    ...(Object.keys(memoryRetrieve).length ? { retrieval: memoryRetrieve } : {}),
  }

  const experienceRetrieve: Record<string, unknown> = {}
  const experienceSim = Number(library.experienceSimThreshold)
  const experienceTopK = positiveInteger(library.experienceTopK)
  const experienceEpsilon = Number(library.experienceEpsilon)
  if (!Number.isNaN(experienceSim) && library.experienceSimThreshold !== "0.7") {
    experienceRetrieve.simThreshold = experienceSim
  }
  if (experienceTopK !== undefined && library.experienceTopK !== "8") experienceRetrieve.topK = experienceTopK
  if (!Number.isNaN(experienceEpsilon) && library.experienceEpsilon !== "0.1") {
    experienceRetrieve.epsilon = experienceEpsilon
  }
  nextLibrary.experience = {
    ...((nextLibrary.experience as Record<string, unknown> | undefined) ?? {}),
    encode: learningBool,
    retrieve: Object.keys(experienceRetrieve).length ? experienceRetrieve : learningBool,
  }
  nextLibrary.autonomy = library.autonomy !== "false"

  patch.library = nextLibrary
}

function buildToastPatch(
  muted: string[],
  durations: SettingsState["general"]["toastDurations"],
): Record<string, unknown> {
  const toast: Record<string, unknown> = {}
  const normalizedMuted = muted.filter((value) => ["info", "success", "warning", "error"].includes(value))
  if (normalizedMuted.length) toast.muted = normalizedMuted
  const durationOverrides = parseToastDurations(durations)
  if (Object.keys(durationOverrides).length) toast.durationOverrides = durationOverrides
  return toast
}

function parseToastDurations(durations: SettingsState["general"]["toastDurations"]): Record<string, number> {
  const result: Record<string, number> = {}
  for (const type of TOAST_TYPES) {
    const raw = durations[type]
    if (!raw.trim()) continue
    const parsed = Number(raw)
    if (!Number.isNaN(parsed) && Number.isInteger(parsed) && parsed > 0 && parsed <= 30000) {
      result[type] = snapToastDuration(parsed)
    }
  }
  return result
}

function parseList(value: string): string[] {
  return value
    .split(/\r?\n|,/)
    .map((item) => item.trim())
    .filter(Boolean)
}

function parseKeyValueLines(value: string, separator: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const line of value.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const index = trimmed.indexOf(separator)
    if (index <= 0) continue
    const key = trimmed.slice(0, index).trim()
    const next = trimmed.slice(index + separator.length).trim()
    if (key) result[key] = next
  }
  return result
}

function parseNumericRecord(value: string): Record<string, number> {
  const result: Record<string, number> = {}
  for (const [key, raw] of Object.entries(parseKeyValueLines(value, "="))) {
    const next = Number(raw)
    if (!Number.isNaN(next) && next > 0) result[key] = next
  }
  return result
}

function positiveNumber(value: string): number | undefined {
  if (!value.trim()) return undefined
  const parsed = Number(value)
  return !Number.isNaN(parsed) && parsed > 0 ? parsed : undefined
}

function nonNegativeNumber(value: string): number | undefined {
  if (!value.trim()) return undefined
  const parsed = Number(value)
  return !Number.isNaN(parsed) && parsed >= 0 ? parsed : undefined
}

function boundedNumber(value: string, min: number, max: number): number | undefined {
  const parsed = Number(value)
  if (Number.isNaN(parsed)) return undefined
  if (parsed < min || parsed > max) return undefined
  return parsed
}

function positiveInteger(value: string): number | undefined {
  const parsed = positiveNumber(value)
  return parsed !== undefined && Number.isInteger(parsed) ? parsed : undefined
}

function nonNegativeInteger(value: string): number | undefined {
  const parsed = nonNegativeNumber(value)
  return parsed !== undefined && Number.isInteger(parsed) ? parsed : undefined
}
