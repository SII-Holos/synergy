import { ScopeContext } from "@/scope/context"
import { ScopedState } from "@/scope/scoped-state"
import { Plugin } from "../plugin"
import { map, filter, pipe, fromEntries, mapValues } from "remeda"
import z from "zod"
import { fn } from "@/util/fn"
import type { AuthHook, AuthOuathResult } from "@ericsanchezok/synergy-plugin"
import { NamedError } from "@ericsanchezok/synergy-util/error"
import { Auth } from "@/provider/api-key"
import { CodexProvider } from "./codex"
import { AnthropicOAuthProvider } from "./anthropic-oauth"
import { CopilotProvider } from "./copilot"
import { MiniMaxProvider } from "./minimax"
import { registerBuiltinProviderProfiles } from "./builtin"

export namespace ProviderAuth {
  const state = ScopedState.create(async () => {
    registerBuiltinProviderProfiles()
    const pluginMethods = pipe(
      await Plugin.allHooks(),
      filter((x) => x.auth?.provider !== undefined),
      map((x) => [x.auth!.provider, x.auth!] as const),
      fromEntries(),
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
    return { methods, pending: {} as Record<string, AuthOuathResult> }
  })

  export const Method = z
    .object({
      type: z.union([z.literal("oauth"), z.literal("api")]),
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
    async (input): Promise<Authorization | undefined> => {
      const auth = await state().then((s) => s.methods[input.providerID])
      const method = auth.methods[input.method]
      if (method.type === "oauth") {
        const result = await method.authorize()
        await state().then((s) => (s.pending[input.providerID] = result))
        return {
          url: result.url,
          method: result.method,
          instructions: result.instructions,
        }
      }
    },
  )

  export const callback = fn(
    z.object({
      providerID: z.string(),
      method: z.number(),
      code: z.string().optional(),
    }),
    async (input) => {
      const match = await state().then((s) => s.pending[input.providerID])
      if (!match) throw new OauthMissing({ providerID: input.providerID })
      let result

      if (match.method === "code") {
        if (!input.code) throw new OauthCodeMissing({ providerID: input.providerID })
        result = await match.callback(input.code)
      }

      if (match.method === "auto") {
        result = await match.callback()
      }

      if (result?.type === "success") {
        if ("key" in result) {
          await Auth.set(
            input.providerID,
            {
              type: "api",
              key: result.key,
            },
            { source: "web" },
          )
        }
        if ("refresh" in result) {
          await Auth.set(
            input.providerID,
            {
              type: "oauth",
              access: result.access,
              refresh: result.refresh,
              expires: result.expires,
            },
            { source: "web" },
          )
        }
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
}
