import type { Config } from "@ericsanchezok/synergy-sdk/client"
import { UI_DEFAULTS, MODEL_ROLES, resolvePermissionForUi } from "../types"
import { normalizeServerToast, toastPatchFromPreferences } from "../toast-preferences"
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
  buildEmbeddingPatch(cfg, state, patch)
  buildModelPatch(cfg, state, patch)
  buildAgentPatch(cfg, state, patch)
  buildProviderPatch(cfg, state, patch)
  buildPluginPatch(cfg, state, patch)
  buildMcpPatch(cfg, state, originalMcps, patch)
  buildSafetyPatch(cfg, state, patch)
  buildRuntimePatch(cfg, state, patch)
  buildEmailPatch(cfg, state, patch)
  buildChannelPatch(cfg, state, patch)
  buildGithubIntegrationPatch(cfg, state, patch)
  buildLibraryPatch(cfg, state, patch)
  buildSkillsPatch(cfg, state, patch)

  return patch
}

function buildGeneralPatch(cfg: Config, state: SettingsState, patch: Record<string, unknown>) {
  const { general } = state
  if (general.snapshot !== (cfg.snapshot ?? UI_DEFAULTS.snapshot)) patch.snapshot = general.snapshot
  if (general.compactReasoning !== (cfg.compactReasoning ?? UI_DEFAULTS.compactReasoning)) {
    patch.compactReasoning = general.compactReasoning
  }

  const username = general.username.trim()
  if (username !== (cfg.username ?? UI_DEFAULTS.username)) patch.username = username || undefined

  // Theme is applied instantly and persisted independently via a background
  // domain update — it must not appear in the normal save-changes patch.

  const resolvedLocale = cfg.locale ?? UI_DEFAULTS.locale
  if (general.locale !== resolvedLocale) patch.locale = general.locale

  const resolvedActivityDisplay = cfg.activityDisplay ?? UI_DEFAULTS.activityDisplay
  if (general.activityDisplay !== resolvedActivityDisplay) patch.activityDisplay = general.activityDisplay

  const resolvedDefaultSessionWorkspace = cfg.defaultSessionWorkspace ?? UI_DEFAULTS.defaultSessionWorkspace
  if (general.defaultSessionWorkspace !== resolvedDefaultSessionWorkspace) {
    patch.defaultSessionWorkspace = general.defaultSessionWorkspace
  }

  const toast = toastPatchFromPreferences(general.mutedToasts, general.toastDurations)
  const current = normalizeServerToast(cfg.toast) ?? { muted: [] }
  // Always include muted so domain mergeDeep can replace/clear the array.
  if (JSON.stringify(toast) !== JSON.stringify(current)) {
    patch.toast = toast
  }
}

function buildEmbeddingPatch(cfg: Config, state: SettingsState, patch: Record<string, unknown>) {
  const source = state.library.embeddingSource
  const remoteHost = state.library.embeddingRemoteHost.trim()
  const cacheDir = state.library.embeddingCacheDir.trim()
  const currentSource = cfg.embedding?.local?.source ?? UI_DEFAULTS.embeddingSource
  const currentRemoteHost = cfg.embedding?.local?.remoteHost ?? UI_DEFAULTS.embeddingRemoteHost
  const currentCacheDir = cfg.embedding?.local?.cacheDir ?? UI_DEFAULTS.embeddingCacheDir
  const nextRemoteHost = source === "custom" ? remoteHost : ""
  if (
    source === currentSource &&
    nextRemoteHost === (source === "custom" ? currentRemoteHost : "") &&
    cacheDir === currentCacheDir
  ) {
    return
  }

  patch.embedding = {
    local: {
      source,
      ...(source === "custom" && nextRemoteHost ? { remoteHost: nextRemoteHost } : {}),
      ...(cacheDir !== currentCacheDir ? { cacheDir } : {}),
    },
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

  const cleanedQuickSwitcher = state.models.quick_switcher.filter(
    (item) => item.providerID && item.modelID && (item.state === "add" || item.state === "remove"),
  )
  if (JSON.stringify(cleanedQuickSwitcher) !== JSON.stringify(cfg.quick_switcher?.models ?? [])) {
    patch.quick_switcher = { models: cleanedQuickSwitcher }
  }
}

function buildAgentPatch(cfg: Config, state: SettingsState, patch: Record<string, unknown>) {
  const defaultAgent = state.agents.defaultAgent.trim()
  if (!defaultAgent) return
  const resolved = cfg.default_agent ?? UI_DEFAULTS.defaultAgent
  if (defaultAgent !== resolved) {
    patch.default_agent = defaultAgent
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
  // Carry `enabled`-only stubs forward: they are opt-out/opt-in markers for
  // built-in servers, not editable server cards, and the mcp config domain
  // merges deep, so an omitted stub would survive every save and keep the
  // patch permanently dirty.
  for (const [key, value] of Object.entries(cfg.mcp ?? {})) {
    const mcp = value as Record<string, unknown>
    if (typeof mcp.type !== "string") newMcp[key] = { ...mcp }
  }
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

  // Built-in server toggles: switching off writes the opt-out stub; switching
  // back on over a stored opt-out writes a bare `enabled: true` stub (the only
  // merge-safe re-enable — it is schema-valid and does not own the name, so
  // the builtin stages again on reload).
  for (const builtin of state.mcps.builtins) {
    const configured = cfg.mcp?.[builtin.name]
    const enabled =
      !configured || typeof configured !== "object" || (configured as Record<string, unknown>).enabled !== false
    if (builtin.toggle === enabled) continue
    newMcp[builtin.name] = { enabled: builtin.toggle }
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
  if (sandboxEnabled !== currentEnabled) sandbox.enabled = sandboxEnabled
  if (safety.sandboxFallbackPolicy !== (cfg.sandbox?.fallbackPolicy ?? UI_DEFAULTS.sandboxFallbackPolicy)) {
    sandbox.fallbackPolicy = safety.sandboxFallbackPolicy
  }
  if (Object.keys(sandbox).length) {
    const nextSandbox = { ...(cfg.sandbox ?? {}), ...sandbox }
    if (JSON.stringify(nextSandbox) !== JSON.stringify(cfg.sandbox ?? {})) {
      patch.sandbox = nextSandbox
    }
  }
}

function buildRuntimePatch(cfg: Config, state: SettingsState, patch: Record<string, unknown>) {
  const { runtime } = state
  const lspWriteDiagnostics = runtime.lspWriteDiagnostics !== "false"
  if (lspWriteDiagnostics !== (cfg.lspWriteDiagnostics !== false)) {
    patch.lspWriteDiagnostics = lspWriteDiagnostics
  }

  const lspDiagnostics = {
    severity: runtime.lspDiagnosticsSeverity as "error" | "warning",
    scope: runtime.lspDiagnosticsScope as "delta" | "file" | "project",
  }
  const currentLspDiagnostics = cfg.lspDiagnostics ?? {
    severity: UI_DEFAULTS.lspDiagnosticsSeverity,
    scope: UI_DEFAULTS.lspDiagnosticsScope,
  }
  if (JSON.stringify(lspDiagnostics) !== JSON.stringify(currentLspDiagnostics)) {
    patch.lspDiagnostics = lspDiagnostics
  }

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

  const cortexConcurrency = positiveInteger(runtime.cortexConcurrency)
  const currentCortexConcurrency = cfg.cortex?.maxConcurrentTasks ?? Number(UI_DEFAULTS.cortexConcurrency)
  if (cortexConcurrency !== undefined && cortexConcurrency !== currentCortexConcurrency) {
    patch.cortex = { maxConcurrentTasks: cortexConcurrency }
  }

  const agentWorkers = boundedInteger(runtime.agentWorkers, 1, 64)
  if (agentWorkers !== undefined && agentWorkers !== cfg.execution?.agentWorkers) {
    patch.execution = { ...(cfg.execution ?? {}), agentWorkers }
  }

  const timeout = buildTimeoutPatch(cfg, runtime)
  if (timeout.changed) patch.timeout = timeout.value

  const experimental: Record<string, unknown> = {}
  const coauthorReminder = runtime.coauthorReminder === "true"
  const currentCoauthorReminder = cfg.experimental?.coauthor_reminder !== false
  if (coauthorReminder !== currentCoauthorReminder) experimental.coauthor_reminder = coauthorReminder

  const bossMode = runtime.bossMode === "true"
  const currentBossMode = cfg.experimental?.boss_mode === true
  if (bossMode !== currentBossMode) experimental.boss_mode = bossMode

  // Clearing an optional value must send null (not undefined): the SDK JSON
  // serializer drops undefined keys, so undefined would never reach the
  // server and the stored value would survive the merge. Schema fields are
  // nullable to accept the explicit clear.
  const bossIdentityText = runtime.bossIdentityText.trim() === "" ? null : runtime.bossIdentityText
  const currentBossIdentityText = cfg.experimental?.boss_identity_text
  // Explicit null clears a stored value (the SDK JSON serializer drops
  // undefined keys, so undefined would keep the old value server-side), but a
  // null clear is only meaningful when the server actually has a value —
  // otherwise the null would materialize an empty experimental block.
  if (
    bossIdentityText !== currentBossIdentityText &&
    (bossIdentityText !== null || currentBossIdentityText !== undefined)
  ) {
    experimental.boss_identity_text = bossIdentityText
  }

  const bossBriefingIntervalRaw = runtime.bossBriefingIntervalDays.trim()
  const bossBriefingIntervalDays =
    bossBriefingIntervalRaw === "" ? null : positiveInteger(runtime.bossBriefingIntervalDays)
  const currentBossBriefingIntervalDays = cfg.experimental?.boss_briefing_interval_days
  // Invalid input (undefined) carries no change intent; null clears a stored
  // value; an explicit number always materializes.
  if (
    bossBriefingIntervalDays !== undefined &&
    bossBriefingIntervalDays !== currentBossBriefingIntervalDays &&
    (bossBriefingIntervalDays !== null || currentBossBriefingIntervalDays !== undefined)
  ) {
    experimental.boss_briefing_interval_days = bossBriefingIntervalDays
  }

  if (Object.keys(experimental).length) {
    patch.experimental = { ...(cfg.experimental ?? {}), ...experimental }
  }

  const watcherIgnore = parseList(runtime.watcherIgnore)
  if (JSON.stringify(watcherIgnore) !== JSON.stringify(cfg.watcher?.ignore ?? [])) {
    patch.watcher = watcherIgnore.length ? { ...(cfg.watcher ?? {}), ignore: watcherIgnore } : undefined
  }

  const logLevel = runtime.logLevel.trim()
  if (logLevel !== (cfg.logLevel ?? UI_DEFAULTS.logLevel)) patch.logLevel = logLevel || undefined

  const performanceEnabled = runtime.performanceEnabled !== "false"
  // The effective backend value honors the master observability.enabled flag
  // when performance.enabled is unset; mirror that so the switch shows the
  // real runtime state and one save can re-enable a master-disabled setup.
  const currentPerformanceEnabled = cfg.observability?.performance?.enabled ?? cfg.observability?.enabled ?? true
  if (performanceEnabled !== currentPerformanceEnabled) {
    patch.observability = {
      ...(cfg.observability ?? {}),
      performance: { ...(cfg.observability?.performance ?? {}), enabled: performanceEnabled },
    }
  }
}

function buildTimeoutPatch(cfg: Config, runtime: SettingsState["runtime"]) {
  const timeout: Record<string, unknown> = {}
  const invoke = positiveNumber(runtime.invokeTimeout)
  if (invoke !== undefined) timeout.invoke_sec = invoke

  const provider: Record<string, unknown> = {}
  const ttfb = positiveNumber(runtime.providerTtfbTimeout)
  const idle = idleTimeoutValue(runtime.providerIdleTimeout)
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
  const feishu = "feishu" in newChannel && newChannel.feishu?.type === "feishu" ? newChannel.feishu : undefined
  if (feishu) {
    for (const entry of state.channels.feishuAccounts) {
      const account = feishu.accounts[entry.key]
      if (!account) continue
      account.enabled = entry.enabled
      account.model = entry.model || undefined
      account.variant = entry.model ? entry.variant || undefined : undefined
    }
  }
  const clarus = "clarus" in newChannel && newChannel.clarus?.type === "clarus" ? newChannel.clarus : undefined
  if (clarus) {
    for (const entry of state.channels.clarusAccounts) {
      const account = clarus.accounts[entry.key]
      if (!account) continue
      account.enabled = entry.enabled
    }
  }
  const github = "github" in newChannel && newChannel.github?.type === "github" ? newChannel.github : undefined
  if (github) {
    for (const entry of state.channels.githubAccounts) {
      const account = github.accounts[entry.key]
      if (!account) continue
      account.enabled = entry.enabled
      account.repositories = parseList(entry.repositories)
      account.workspaceDir = entry.workspaceDir.trim()
      const workspaceTtlHours = positiveInteger(entry.workspaceTtlHours)
      if (workspaceTtlHours !== undefined) account.workspaceTtlHours = workspaceTtlHours
      else delete account.workspaceTtlHours
      const pollingIntervalMs = positiveInteger(entry.pollingIntervalMs)
      if (pollingIntervalMs !== undefined) account.pollingIntervalMs = pollingIntervalMs
      else delete account.pollingIntervalMs
      account.autoReview = entry.autoReview
      account.autoRespond = entry.autoRespond
      if (entry.mention.trim()) account.mention = entry.mention.trim()
      else delete account.mention
    }
  }
  if (JSON.stringify(newChannel) !== JSON.stringify(currentChannel)) patch.channel = newChannel
}

function buildGithubIntegrationPatch(cfg: Config, state: SettingsState, patch: Record<string, unknown>) {
  const { github } = state
  const name = github.identitySyncName.trim()
  const email = github.identitySyncEmail.trim()
  // name/email are sent as explicit null when cleared: the github config
  // domain merges deep, so omitting the key would keep the stored override.
  // The server schema treats null as "remove this override".
  const next = {
    identitySync: {
      enabled: github.identitySyncEnabled,
      ...(name ? { name } : cfg.github?.identitySync?.name ? { name: null } : {}),
      ...(email ? { email } : cfg.github?.identitySync?.email ? { email: null } : {}),
    },
    watch: { enabled: github.watchEnabled },
  }
  const current = {
    identitySync: {
      enabled: cfg.github?.identitySync?.enabled === true,
      ...(cfg.github?.identitySync?.name ? { name: cfg.github.identitySync.name } : {}),
      ...(cfg.github?.identitySync?.email ? { email: cfg.github.identitySync.email } : {}),
    },
    watch: { enabled: cfg.github?.watch?.enabled !== false },
  }
  if (JSON.stringify(next) !== JSON.stringify(current)) patch.github = next
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
function buildSkillsPatch(cfg: Config, state: SettingsState, patch: Record<string, unknown>) {
  const { skills } = state
  const compatibility = cfg.skills?.compatibility
  const next: Record<string, boolean> = {}
  for (const source of ["agents", "claude", "codex", "openclaw"] as const) {
    const current = compatibility?.[source] !== false
    if (skills[source] !== current) next[source] = skills[source]
  }
  if (Object.keys(next).length === 0) return

  patch.skills = { compatibility: next }
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

function idleTimeoutValue(value: string): number | false | undefined {
  const trimmed = value.trim().toLowerCase()
  if (trimmed === "false") return false
  return nonNegativeNumber(value)
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

function boundedInteger(value: string, min: number, max: number): number | undefined {
  const parsed = boundedNumber(value, min, max)
  return parsed !== undefined && Number.isInteger(parsed) ? parsed : undefined
}

function nonNegativeInteger(value: string): number | undefined {
  const parsed = nonNegativeNumber(value)
  return parsed !== undefined && Number.isInteger(parsed) ? parsed : undefined
}
