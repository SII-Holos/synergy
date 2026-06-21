import type { Config } from "@ericsanchezok/synergy-sdk/client"
import { MODEL_ROLES, UI_DEFAULTS, resolvePermissionForUi } from "../types"
import type {
  GeneralStore,
  ModelsStore,
  PluginsStore,
  McpsStore,
  IdentityStore,
  AdvancedStore,
  EmailSettings,
  ChannelSettings,
} from "../types"
export type BuildPatchParams = {
  cfg: Config
  general: GeneralStore
  models: ModelsStore
  plugins: PluginsStore
  mcps: McpsStore
  advanced: AdvancedStore
  email: EmailSettings
  channels: ChannelSettings
  identity: IdentityStore
  originalMcps: Record<string, Record<string, unknown>>
}

/**
 * Build a PATCH payload containing only fields that differ from the resolved config.
 * Phase 1 backend returns resolved defaults, so form values are always real (no "" sentinel).
 */
export function buildPatch(params: BuildPatchParams): Record<string, unknown> {
  const { cfg, general, models, plugins, mcps, advanced, email, channels, identity, originalMcps } = params
  const patch: Record<string, unknown> = {}

  if (general.snapshot !== (cfg.snapshot ?? true)) patch.snapshot = general.snapshot

  const origControlProfile = cfg.controlProfile ?? UI_DEFAULTS.controlProfile
  if (advanced.controlProfile !== origControlProfile) patch.controlProfile = advanced.controlProfile

  const autoupdateOrig = cfg.autoupdate === undefined ? UI_DEFAULTS.autoupdate : String(cfg.autoupdate)
  if (general.autoupdate !== autoupdateOrig) {
    if (general.autoupdate === "true") patch.autoupdate = true
    else if (general.autoupdate === "false") patch.autoupdate = false
    else if (general.autoupdate === "notify") patch.autoupdate = "notify"
  }

  for (const role of MODEL_ROLES) {
    const origVal = (cfg[role.key as keyof typeof cfg] as string | undefined) ?? ""
    const newVal = models[role.key]
    if (newVal !== origVal) {
      patch[role.key] = newVal || undefined
    }
  }

  const origPlugin = JSON.stringify(cfg.plugin ?? [])
  const newPlugin = plugins.entries.map((entry) => entry.value).filter((value) => value.trim())
  if (JSON.stringify(newPlugin) !== origPlugin) {
    patch.plugin = newPlugin
  }

  const origMcp = JSON.stringify(cfg.mcp ?? {})
  const newMcpObj: Record<string, Record<string, unknown>> = {}
  for (const entry of mcps.entries) {
    if (!entry.key.trim()) continue
    const key = entry.key.trim()
    const base = { ...(originalMcps[key] ?? {}) }

    base.type = entry.type
    base.enabled = entry.enabled

    if (entry.type === "local") {
      const parts = entry.command.trim().split(/\s+/)
      if (parts.length > 0 && parts[0]) base.command = parts
      else delete base.command
      delete base.url
    } else {
      if (entry.url.trim()) base.url = entry.url.trim()
      else delete base.url
      delete base.command
    }

    if (entry.timeout) {
      const timeout = Number(entry.timeout)
      if (!isNaN(timeout) && timeout > 0) base.timeout = timeout
    } else {
      delete base.timeout
    }

    if (entry.type === "local" && entry.environment.trim()) {
      const env: Record<string, string> = {}
      for (const line of entry.environment.split("\n")) {
        const eq = line.indexOf("=")
        if (eq >= 0) env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim()
      }
      if (Object.keys(env).length) base.environment = env
      else delete base.environment
    } else if (entry.type === "local") {
      delete base.environment
    }

    if (entry.type === "remote" && entry.headers.trim()) {
      const hdrs: Record<string, string> = {}
      for (const line of entry.headers.split("\n")) {
        const colon = line.indexOf(":")
        if (colon > 0) hdrs[line.slice(0, colon).trim()] = line.slice(colon + 1).trim()
      }
      if (Object.keys(hdrs).length) base.headers = hdrs
      else delete base.headers
    } else if (entry.type === "remote") {
      delete base.headers
    }

    newMcpObj[key] = base
  }
  if (JSON.stringify(newMcpObj) !== origMcp) {
    patch.mcp = newMcpObj
  }

  const origCompaction = cfg.compaction
  const origAutoStr = origCompaction?.auto !== false ? "true" : "false"
  const origThresholdStr = String(origCompaction?.overflowThreshold ?? 0.85)
  const compactionChanged =
    advanced.compaction_auto !== origAutoStr || advanced.compaction_overflow_threshold !== origThresholdStr
  if (compactionChanged) {
    const newCompaction: Record<string, unknown> = {}
    if (advanced.compaction_auto === "true") newCompaction.auto = true
    else if (advanced.compaction_auto === "false") newCompaction.auto = false
    if (advanced.compaction_overflow_threshold !== "") {
      const val = Number(advanced.compaction_overflow_threshold)
      if (!isNaN(val) && val >= 0.5 && val <= 1) newCompaction.overflowThreshold = val
    }
    patch.compaction = Object.keys(newCompaction).length > 0 ? newCompaction : undefined
  }

  const origPermission = resolvePermissionForUi(cfg.permission)
  if (advanced.permission !== origPermission) {
    patch.permission = advanced.permission || undefined
  }

  const origAutoClassifier = (cfg as Record<string, unknown>).auto_classifier === true ? "true" : "false"
  if (advanced.auto_classifier !== origAutoClassifier) {
    patch.auto_classifier = advanced.auto_classifier === "true"
  }

  const origEmail = JSON.stringify(cfg.email ?? {})
  const hasEmailFrom = email.fromAddress.trim() || email.fromName.trim()
  const hasEmailSmtp =
    email.smtpHost.trim() ||
    email.smtpPort.trim() ||
    email.smtpUsername.trim() ||
    email.smtpPassword.trim() ||
    email.smtpSecure !== true
  const hasEmailImap =
    email.imapHost.trim() ||
    email.imapPort.trim() ||
    email.imapUsername.trim() ||
    email.imapPassword.trim() ||
    email.imapSecure !== true
  const shouldMaterializeEmail =
    hasEmailFrom || hasEmailSmtp || hasEmailImap || email.enabled !== true || cfg.email !== undefined
  const newEmail: Record<string, unknown> = {}
  if (shouldMaterializeEmail) {
    if (email.enabled !== true || cfg.email?.enabled !== undefined) {
      newEmail.enabled = email.enabled
    }
    if (hasEmailFrom) {
      newEmail.from = {
        ...(email.fromAddress.trim() ? { address: email.fromAddress.trim() } : {}),
        ...(email.fromName.trim() ? { name: email.fromName.trim() } : {}),
      }
    }
    if (hasEmailSmtp) {
      newEmail.smtp = {
        ...(email.smtpHost.trim() ? { host: email.smtpHost.trim() } : {}),
        ...(email.smtpPort.trim() ? { port: Number(email.smtpPort) } : {}),
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
        ...(email.imapPort.trim() ? { port: Number(email.imapPort) } : {}),
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
  if (JSON.stringify(newEmail) !== origEmail) {
    patch.email = Object.keys(newEmail).length > 0 ? newEmail : undefined
  }

  const origChannel = JSON.stringify(cfg.channel ?? {})
  const newChannel = structuredClone(cfg.channel ?? {}) as NonNullable<Config["channel"]> | {}
  if ("feishu" in newChannel && newChannel.feishu?.accounts) {
    for (const entry of channels.feishuAccounts) {
      const account = newChannel.feishu.accounts[entry.key]
      if (account) account.enabled = entry.enabled
    }
  }
  if (JSON.stringify(newChannel) !== origChannel) {
    patch.channel = newChannel
  }

  const origEngram = cfg.engram
  const origMemory = origEngram?.memory
  const origExperience = origEngram?.experience
  const origEvoStr = (() => {
    if (origMemory?.enabled === false && origExperience?.encode === false && origExperience?.retrieve === false) {
      return "false"
    }
    return "true"
  })()
  const origAutonomyStr = origEngram?.autonomy !== undefined ? (origEngram.autonomy ? "true" : "false") : "true"

  const origMemorySimThreshold = (() => {
    const retrieve = typeof origMemory?.retrieval === "object" ? origMemory.retrieval : undefined
    return retrieve?.simThreshold !== undefined ? String(retrieve.simThreshold) : String(0.7)
  })()
  const origMemoryTopK = (() => {
    const retrieve = typeof origMemory?.retrieval === "object" ? origMemory.retrieval : undefined
    return retrieve?.topK !== undefined ? String(retrieve.topK) : String(3)
  })()
  const origExperienceSimThreshold = (() => {
    const retrieve = typeof origExperience?.retrieve === "object" ? origExperience.retrieve : undefined
    return retrieve?.simThreshold !== undefined ? String(retrieve.simThreshold) : String(0.7)
  })()
  const origExperienceTopK = (() => {
    const retrieve = typeof origExperience?.retrieve === "object" ? origExperience.retrieve : undefined
    return retrieve?.topK !== undefined ? String(retrieve.topK) : String(8)
  })()
  const origExperienceEpsilon = (() => {
    const retrieve = typeof origExperience?.retrieve === "object" ? origExperience.retrieve : undefined
    return retrieve?.epsilon !== undefined ? String(retrieve.epsilon) : String(0.1)
  })()

  const identityChanged =
    identity.evolution !== origEvoStr ||
    identity.autonomy !== origAutonomyStr ||
    identity.memorySimThreshold !== origMemorySimThreshold ||
    identity.memoryTopK !== origMemoryTopK ||
    identity.experienceSimThreshold !== origExperienceSimThreshold ||
    identity.experienceTopK !== origExperienceTopK ||
    identity.experienceEpsilon !== origExperienceEpsilon

  if (identityChanged) {
    const newEngram = structuredClone(origEngram ?? {}) as Record<string, unknown>

    const evoVal = identity.evolution !== origEvoStr ? identity.evolution : origEvoStr
    if (evoVal === "true" || evoVal === "false") {
      const evoBool = evoVal === "true"

      const memoryRetrieve: Record<string, unknown> = {}
      const memSim =
        identity.memorySimThreshold !== origMemorySimThreshold ? identity.memorySimThreshold : origMemorySimThreshold
      if (memSim !== String(0.7)) {
        const n = Number(memSim)
        if (!isNaN(n)) memoryRetrieve.simThreshold = n
      }
      const memTopK = identity.memoryTopK !== origMemoryTopK ? identity.memoryTopK : origMemoryTopK
      if (memTopK !== String(3)) {
        const n = Number(memTopK)
        if (!isNaN(n) && n >= 1) memoryRetrieve.topK = n
      }

      const experienceRetrieve: Record<string, unknown> = {}
      const expSim =
        identity.experienceSimThreshold !== origExperienceSimThreshold
          ? identity.experienceSimThreshold
          : origExperienceSimThreshold
      if (expSim !== String(0.7)) {
        const n = Number(expSim)
        if (!isNaN(n)) experienceRetrieve.simThreshold = n
      }
      const expTopK = identity.experienceTopK !== origExperienceTopK ? identity.experienceTopK : origExperienceTopK
      if (expTopK !== String(8)) {
        const n = Number(expTopK)
        if (!isNaN(n) && n >= 1) experienceRetrieve.topK = n
      }
      const expEps =
        identity.experienceEpsilon !== origExperienceEpsilon ? identity.experienceEpsilon : origExperienceEpsilon
      if (expEps !== String(0.1)) {
        const n = Number(expEps)
        if (!isNaN(n)) experienceRetrieve.epsilon = n
      }

      if (Object.keys(memoryRetrieve).length > 0) {
        newEngram.memory = {
          ...((newEngram.memory as Record<string, unknown> | undefined) ?? {}),
          retrieval: memoryRetrieve,
        }
      } else {
        newEngram.memory = { ...((newEngram.memory as Record<string, unknown> | undefined) ?? {}), enabled: evoBool }
      }
      if (Object.keys(experienceRetrieve).length > 0) {
        newEngram.experience = {
          ...((newEngram.experience as Record<string, unknown> | undefined) ?? {}),
          retrieve: experienceRetrieve,
        }
      } else {
        newEngram.experience = { encode: evoBool, retrieve: evoBool }
      }
    } else {
      newEngram.memory = { ...((newEngram.memory as Record<string, unknown> | undefined) ?? {}), enabled: false }
      newEngram.experience = { encode: false, retrieve: false }
    }

    const autoVal = identity.autonomy !== origAutonomyStr ? identity.autonomy : origAutonomyStr
    if (autoVal === "true") newEngram.autonomy = true
    else if (autoVal === "false") newEngram.autonomy = false

    patch.engram = Object.keys(newEngram).length > 0 ? newEngram : undefined
  }

  return patch
}
