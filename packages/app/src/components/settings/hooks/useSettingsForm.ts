import type { Config } from "@ericsanchezok/synergy-sdk/client"
import type { SendShortcut } from "@/context/input"
import type {
  GeneralStore,
  ModelsStore,
  PluginsStore,
  McpsStore,
  McpEntry,
  IdentityStore,
  AdvancedStore,
  EmailSettings,
  ChannelSettings,
} from "../types"
import { MODEL_DEFAULTS } from "../types"

export type EnsureInitParams = {
  cfg: Config | undefined
  setName: string | undefined
  refreshing: () => boolean
  initialized: () => boolean
  initializedForSet: string | undefined
  sendShortcut: () => SendShortcut
  setGeneral: (values: Partial<GeneralStore>) => void
  setModels: (values: Partial<ModelsStore>) => void
  setPlugins: (values: Partial<PluginsStore>) => void
  setMcps: (values: Partial<McpsStore>) => void
  setAdvanced: (values: Partial<AdvancedStore>) => void
  setEmail: (values: Partial<EmailSettings>) => void
  setChannels: (values: Partial<ChannelSettings>) => void
  setIdentity: (values: Partial<IdentityStore>) => void
  setInitialized: (value: boolean) => void
  originalMcpsRef: { current: Record<string, Record<string, unknown>> }
}

/**
 * Populate local form stores from resolved config.
 * Phase 1 backend returns resolved defaults, so values are never undefined;
 * all booleans and strings are their actual resolved values.
 */
export function ensureInit(params: EnsureInitParams): string | undefined {
  if (params.refreshing()) return undefined
  const cfg = params.cfg
  const setName = params.setName
  if (!cfg || !setName) return undefined
  if (params.initialized() && params.initializedForSet === setName) return undefined

  params.setGeneral({
    snapshot: cfg.snapshot ?? true,
    autoupdate: String(cfg.autoupdate ?? "notify"),
    sendShortcut: params.sendShortcut(),
  })

  params.setModels({
    model: cfg.model ?? MODEL_DEFAULTS.model,
    nano_model: cfg.nano_model ?? MODEL_DEFAULTS.nano_model,
    mini_model: cfg.mini_model ?? MODEL_DEFAULTS.mini_model,
    mid_model: cfg.mid_model ?? MODEL_DEFAULTS.mid_model,
    vision_model: cfg.vision_model ?? MODEL_DEFAULTS.vision_model,
    holos_friend_reply_model: cfg.holos_friend_reply_model ?? MODEL_DEFAULTS.holos_friend_reply_model,
    thinking_model: cfg.thinking_model ?? MODEL_DEFAULTS.thinking_model,
    long_context_model: cfg.long_context_model ?? MODEL_DEFAULTS.long_context_model,
    creative_model: cfg.creative_model ?? MODEL_DEFAULTS.creative_model,
  })

  params.setPlugins({
    entries: (cfg.plugin ?? []).map((v) => ({ value: v })),
  })

  params.originalMcpsRef.current = {}
  if (cfg.mcp) {
    for (const [key, m] of Object.entries(cfg.mcp)) {
      params.originalMcpsRef.current[key] = { ...(m as Record<string, unknown>) }
    }
  }
  params.setMcps({
    entries: cfg.mcp
      ? Object.entries(cfg.mcp).map(([key, m]) => {
          const mcp = m as Record<string, unknown>
          const isLocal = mcp.type === "local"
          const env = mcp.environment as Record<string, string> | undefined
          const hdrs = mcp.headers as Record<string, string> | undefined
          return {
            key,
            type: (isLocal ? "local" : "remote") as "local" | "remote",
            enabled: mcp.enabled !== false,
            command: isLocal && Array.isArray(mcp.command) ? (mcp.command as string[]).join(" ") : "",
            url: !isLocal && typeof mcp.url === "string" ? mcp.url : "",
            timeout: mcp.timeout !== undefined ? String(mcp.timeout) : "",
            environment: env
              ? Object.entries(env)
                  .map(([k, v]) => `${k}=${v}`)
                  .join("\n")
              : "",
            headers: hdrs
              ? Object.entries(hdrs)
                  .map(([k, v]) => `${k}: ${v}`)
                  .join("\n")
              : "",
          }
        })
      : [],
  })

  params.setAdvanced({
    compaction_auto: cfg.compaction?.auto !== false ? "true" : "false",
    compaction_overflow_threshold: String(cfg.compaction?.overflowThreshold ?? 0.85),
    permission: (() => {
      const permission = cfg.permission
      if (!permission) return "ask"
      if (typeof permission === "string") return permission
      return "ask"
    })(),
    question_timeout: String(cfg.question?.timeout ?? 1800),
  })

  params.setEmail({
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

  const feishuAccounts = cfg.channel?.feishu?.accounts
  params.setChannels({
    feishuAccounts: feishuAccounts
      ? Object.entries(feishuAccounts).map(([key, account]) => ({
          key,
          enabled: account.enabled !== false,
        }))
      : [],
  })

  const ident = cfg.identity
  const evolution = ident?.evolution
  params.setIdentity({
    evolution: (() => {
      if (evolution === undefined) return "true"
      if (typeof evolution === "boolean") return evolution ? "true" : "false"
      const passive = evolution.passive
      const active = evolution.active
      if (passive === false && active === false) return "false"
      return "true"
    })(),
    autonomy: (() => {
      if (ident?.autonomy === undefined) return "true"
      return ident.autonomy ? "true" : "false"
    })(),
    memorySimThreshold: (() => {
      const retrieve =
        typeof evolution === "object" && evolution?.active && typeof evolution.active === "object"
          ? evolution.active.retrieve
          : undefined
      return typeof retrieve === "object" && retrieve?.simThreshold !== undefined
        ? String(retrieve.simThreshold)
        : String(0.7)
    })(),
    memoryTopK: (() => {
      const retrieve =
        typeof evolution === "object" && evolution?.active && typeof evolution.active === "object"
          ? evolution.active.retrieve
          : undefined
      return typeof retrieve === "object" && retrieve?.topK !== undefined ? String(retrieve.topK) : String(3)
    })(),
    experienceSimThreshold: (() => {
      const passive =
        typeof evolution === "object" && evolution?.passive && typeof evolution.passive === "object"
          ? evolution.passive
          : undefined
      const retrieve = passive && typeof passive.retrieve === "object" ? passive.retrieve : undefined
      return retrieve && typeof retrieve === "object" && retrieve.simThreshold !== undefined
        ? String(retrieve.simThreshold)
        : String(0.7)
    })(),
    experienceTopK: (() => {
      const passive =
        typeof evolution === "object" && evolution?.passive && typeof evolution.passive === "object"
          ? evolution.passive
          : undefined
      const retrieve = passive && typeof passive.retrieve === "object" ? passive.retrieve : undefined
      return retrieve && typeof retrieve === "object" && retrieve.topK !== undefined ? String(retrieve.topK) : String(8)
    })(),
    experienceEpsilon: (() => {
      const passive =
        typeof evolution === "object" && evolution?.passive && typeof evolution.passive === "object"
          ? evolution.passive
          : undefined
      const retrieve = passive && typeof passive.retrieve === "object" ? passive.retrieve : undefined
      return retrieve && typeof retrieve === "object" && retrieve.epsilon !== undefined
        ? String(retrieve.epsilon)
        : String(0.1)
    })(),
  })

  return setName
}
