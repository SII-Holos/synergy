import { ScopeContext } from "@/scope/context"
import { ScopedState } from "@/scope/scoped-state"
import { ProviderPluginAuth } from "./plugin-auth-source"
import { mapValues } from "remeda"
import z from "zod"
import { fn } from "@/util/fn"
import type { AuthHook, AuthImportResult, AuthOuathResult } from "@ericsanchezok/synergy-plugin/auth"
import { NamedError } from "@ericsanchezok/synergy-util/error"
import { Auth } from "@/provider/api-key"
import { GrokProvider } from "./grok"
import { CodexProvider } from "./codex"
import { AnthropicOAuthProvider } from "./anthropic-oauth"
import { CopilotProvider } from "./copilot"
import { MiniMaxProvider } from "./minimax"
import { GitHubProvider } from "./github"
import { registerBuiltinProviderProfiles } from "./builtin"
import { Provider } from "./provider"
import { RuntimeReloadExecutor } from "@/config/reload-executor"
import { ProviderAuthHealth } from "./auth-health"
import { Config } from "@/config/config"
import { ProviderProfile } from "./profile"

type AutoOauthResult = Extract<AuthOuathResult, { method: "auto" }>
type PendingOauthResult =
  | Extract<AuthOuathResult, { method: "code" }>
  | (Omit<AutoOauthResult, "callback"> & {
      callback(signal?: AbortSignal): ReturnType<AutoOauthResult["callback"]>
    })

export namespace ProviderAuth {
  function retargetResult<T extends AuthImportResult>(result: T, providerID: string): T {
    if (result.type !== "success") return result
    return { ...result, provider: providerID }
  }

  function retargetOauth(result: AuthOuathResult, providerID: string): AuthOuathResult {
    if (result.method === "code") {
      return {
        ...result,
        callback: async (code) => retargetResult(await result.callback(code), providerID),
      }
    }
    const callback = result.callback as (signal?: AbortSignal) => ReturnType<AutoOauthResult["callback"]>
    return {
      ...result,
      callback: async (signal?: AbortSignal) => retargetResult(await callback(signal), providerID),
    }
  }

  function retargetHook(
    hook: AuthHook,
    providerID: string,
    profileID: string,
    options?: { enterpriseUrl?: string },
  ): AuthHook {
    return {
      ...hook,
      provider: providerID,
      methods: hook.methods.map((method) => {
        if (method.type === "oauth") {
          return {
            ...method,
            authorize: async (inputs?: Record<string, string>) => {
              const result =
                profileID === CopilotProvider.PROVIDER_ID || profileID === CopilotProvider.ENTERPRISE_PROVIDER_ID
                  ? await CopilotProvider.authorizeDeviceCode(providerID, fetch, {
                      enterprise: profileID === CopilotProvider.ENTERPRISE_PROVIDER_ID,
                      enterpriseUrl: options?.enterpriseUrl,
                    })
                  : await method.authorize(inputs)
              return retargetOauth(result, providerID)
            },
          }
        }
        if (method.type === "api" && method.authorize) {
          return {
            ...method,
            authorize: async (inputs?: Record<string, string>) =>
              retargetResult(await method.authorize!(inputs), providerID),
          }
        }
        if (method.type === "import") {
          return {
            ...method,
            import: async (inputs?: Record<string, string>) => retargetResult(await method.import(inputs), providerID),
          }
        }
        return method
      }),
    }
  }

  async function reloadProvider(reason: string) {
    if (ScopeContext.tryScope()) {
      await RuntimeReloadExecutor.reload({ targets: ["provider"], reason })
      return
    }
    await Provider.reload()
  }

  const state = ScopedState.create(async () => {
    registerBuiltinProviderProfiles()
    const pluginMethods = Object.fromEntries(
      ((await ProviderPluginAuth.get()?.authProviderHooks()) ?? []).map(({ providerID, hook }) => [providerID, hook]),
    ) as Record<string, AuthHook>
    const builtinMethods: Record<string, AuthHook> = {
      [CodexProvider.PROVIDER_ID]: {
        provider: CodexProvider.PROVIDER_ID,
        methods: [
          {
            type: "oauth" as const,
            label: "Login with ChatGPT",
            authorize: () => CodexProvider.authorizeDeviceCode(),
          },
          {
            type: "import" as const,
            label: "Import Codex CLI credentials",
            import: async (): Promise<AuthImportResult> => {
              const token = await CodexProvider.importCodexCliAuth()
              if (!token) {
                return {
                  type: "failed",
                  message: `No valid Codex CLI auth.json found under ${CodexProvider.codexHome()}.`,
                }
              }
              return {
                type: "success",
                provider: CodexProvider.PROVIDER_ID,
                access: token.access,
                refresh: token.refresh,
                expires: token.expires,
              }
            },
          },
        ],
      },
      [GrokProvider.PROVIDER_ID]: {
        provider: GrokProvider.PROVIDER_ID,
        methods: [
          {
            type: "oauth" as const,
            label: "Login with Grok",
            authorize: () => GrokProvider.authorizeDeviceCode(),
          },
        ],
      },
      [AnthropicOAuthProvider.PROVIDER_ID]: {
        provider: AnthropicOAuthProvider.PROVIDER_ID,
        methods: [
          {
            type: "oauth" as const,
            label: "Login with Claude Pro/Max",
            authorize: () => AnthropicOAuthProvider.authorizeOAuth(),
          },
          {
            type: "api" as const,
            label: "API key",
          },
        ],
      },
      [CopilotProvider.PROVIDER_ID]: {
        provider: CopilotProvider.PROVIDER_ID,
        methods: [
          {
            type: "oauth" as const,
            label: "Login with GitHub Copilot",
            authorize: () => CopilotProvider.authorizeDeviceCode(CopilotProvider.PROVIDER_ID),
          },
          {
            type: "api" as const,
            label: "GitHub token",
          },
        ],
      },
      [CopilotProvider.ENTERPRISE_PROVIDER_ID]: {
        provider: CopilotProvider.ENTERPRISE_PROVIDER_ID,
        methods: [
          {
            type: "oauth" as const,
            label: "Login with GitHub Copilot Enterprise",
            authorize: () => CopilotProvider.authorizeDeviceCode(CopilotProvider.ENTERPRISE_PROVIDER_ID),
          },
          {
            type: "api" as const,
            label: "GitHub token",
          },
        ],
      },
      [GitHubProvider.PROVIDER_ID]: {
        provider: GitHubProvider.PROVIDER_ID,
        methods: [
          {
            type: "api" as const,
            label: "GitHub token",
          },
          {
            type: "oauth" as const,
            label: "Sign in with GitHub",
            authorize: () => GitHubProvider.authorizeDeviceCode(),
          },
        ],
      },
      [MiniMaxProvider.PROVIDER_ID]: {
        provider: MiniMaxProvider.PROVIDER_ID,
        methods: [
          {
            type: "oauth" as const,
            label: "Login with MiniMax",
            authorize: () => MiniMaxProvider.authorizeOAuth(),
          },
        ],
      },
    }
    const methods: Record<string, AuthHook> = { ...builtinMethods, ...pluginMethods }
    const config = await Config.current()
    for (const [providerID, provider] of Object.entries(config.provider ?? {})) {
      if (!provider.profile) continue
      const profile = ProviderProfile.get(provider.profile)
      const profileID = profile?.id ?? provider.profile
      const source = methods[profileID]
      if (!source) continue
      methods[providerID] = retargetHook(source, providerID, profileID, {
        enterpriseUrl: provider.options?.enterpriseUrl,
      })
    }
    return { methods, pending: {} as Record<string, PendingOauthResult> }
  })

  export const Method = z
    .object({
      type: z.union([z.literal("oauth"), z.literal("api"), z.literal("import")]),
      label: z.string(),
    })
    .meta({
      ref: "ProviderAuthMethod",
    })
  export type Method = z.infer<typeof Method>

  export async function methods() {
    const s = await state().then((x) => x.methods)
    return mapValues(s, (x) =>
      x.methods.map(
        (y): Method => ({
          type: y.type,
          label: y.label,
        }),
      ),
    )
  }

  export async function hook(providerID: string) {
    return state().then((x) => x.methods[providerID])
  }

  export async function reload() {
    await state.resetAll()
  }

  export const Authorization = z
    .object({
      url: z.string(),
      method: z.union([z.literal("auto"), z.literal("code")]),
      instructions: z.string(),
    })
    .meta({
      ref: "ProviderAuthAuthorization",
    })
  export type Authorization = z.infer<typeof Authorization>

  export const authorize = fn(
    z.object({
      providerID: z.string(),
      method: z.number(),
    }),
    async (input) => {
      const auth = await state().then((s) => s.methods[input.providerID])
      const method = auth.methods[input.method]
      if (method.type === "oauth") {
        const result = await method.authorize().catch((original) => {
          throw new OauthNotConfigured({
            providerID: input.providerID,
            message: original instanceof Error ? original.message : String(original),
          })
        })
        await state().then((s) => (s.pending[input.providerID] = result))
        return {
          url: result.url,
          method: result.method,
          instructions: result.instructions,
        }
      }
    },
  )

  async function persistResult(providerID: string, result: AuthImportResult, source: Auth.Source) {
    if (result.type !== "success") return false
    const saveProvider = result.provider ?? providerID
    if ("key" in result) {
      await Auth.set(
        saveProvider,
        {
          type: "api",
          key: result.key,
        },
        { source },
      )
      await reloadProvider(`provider credentials connected: ${saveProvider}`)
      return true
    }
    await Auth.set(
      saveProvider,
      {
        type: "oauth",
        access: result.access,
        refresh: result.refresh,
        expires: result.expires,
      },
      { source },
    )
    await reloadProvider(`provider credentials connected: ${saveProvider}`)
    return true
  }

  export const importCredentials = fn(
    z.object({
      providerID: z.string(),
      method: z.number(),
    }),
    async (input) => {
      const auth = await state().then((s) => s.methods[input.providerID])
      const method = auth?.methods[input.method]
      if (!method || method.type !== "import") throw new ImportUnavailable({ providerID: input.providerID })
      const result = await method.import()
      if (await persistResult(input.providerID, result, "import")) return
      throw new ImportFailed({
        providerID: input.providerID,
        message: result.type === "failed" ? result.message : undefined,
      })
    },
  )

  export const callback = fn(
    z.object({
      providerID: z.string(),
      method: z.number(),
      code: z.string().optional(),
      signal: z.instanceof(AbortSignal).optional(),
    }),
    async (input) => {
      const s = await state()
      const match = s.pending[input.providerID]
      if (!match) throw new OauthMissing({ providerID: input.providerID })
      let result
      if (match.method === "code") {
        if (!input.code) throw new OauthCodeMissing({ providerID: input.providerID })
        result = await match.callback(input.code)
      } else {
        delete s.pending[input.providerID]
        result = await match.callback(input.signal)
      }

      if (result.type === "success") {
        if (match.method === "code") delete s.pending[input.providerID]
        await persistResult(input.providerID, result, "web")
        return
      }

      throw new OauthCallbackFailed({})
    },
  )

  export const api = fn(
    z.object({
      providerID: z.string(),
      key: z.string(),
    }),
    async (input) => {
      await Auth.set(
        input.providerID,
        {
          type: "api",
          key: input.key,
        },
        { source: "web" },
      )
      await reloadProvider(`provider credentials connected: ${input.providerID}`)
    },
  )

  export const DisconnectUnavailable = NamedError.create(
    "ProviderAuthDisconnectUnavailableError",
    z.object({
      providerID: z.string(),
      status: ProviderAuthHealth.Info.shape.status,
    }),
  )

  export const disconnect = fn(
    z.object({
      providerID: z.string().min(1),
    }),
    async (input) => {
      let status: ProviderAuthHealth.Info["status"] = "not_configured"
      const result = await Auth.removeIf(input.providerID, (entry) => {
        const health = ProviderAuthHealth.fromStoredEntry(input.providerID, entry)
        status = health.status
        return health.canDisconnect === true
      })
      if (result === "retained") throw new DisconnectUnavailable({ providerID: input.providerID, status })
      if (result === "removed") await reloadProvider(`provider credentials removed: ${input.providerID}`)
    },
  )

  export const OauthMissing = NamedError.create(
    "ProviderAuthOauthMissing",
    z.object({
      providerID: z.string(),
    }),
  )
  export const OauthCodeMissing = NamedError.create(
    "ProviderAuthOauthCodeMissing",
    z.object({
      providerID: z.string(),
    }),
  )

  export const OauthCallbackFailed = NamedError.create("ProviderAuthOauthCallbackFailed", z.object({}))

  export const OauthNotConfigured = NamedError.create(
    "ProviderAuthOauthNotConfigured",
    z.object({
      providerID: z.string(),
      message: z.string().optional(),
    }),
  )

  export const ImportUnavailable = NamedError.create(
    "ProviderAuthImportUnavailable",
    z.object({
      providerID: z.string(),
    }),
  )
  export const ImportFailed = NamedError.create(
    "ProviderAuthImportFailed",
    z.object({
      providerID: z.string(),
      message: z.string().optional(),
    }),
  )
}
