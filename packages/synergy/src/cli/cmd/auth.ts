import { Auth } from "../../provider/api-key"
import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
import { UI } from "../ui"
import { ModelsDev } from "../../provider/models"
import { map, pipe, sortBy, values } from "remeda"
import path from "path"
import os from "os"
import { Config } from "../../config/config"
import { Global } from "../../global"
import { Plugin } from "../../plugin"
import { ScopeContext } from "../../scope/context"
import { Scope } from "@/scope"
import type { PluginHooks } from "@ericsanchezok/synergy-plugin"
import { CodexProvider } from "@/provider/codex"
import { ProviderCatalog } from "@/provider/catalog"
import { AnthropicOAuthProvider } from "@/provider/anthropic-oauth"
import { CopilotProvider } from "@/provider/copilot"
import { MiniMaxProvider } from "@/provider/minimax"
import type { AuthOuathResult } from "@ericsanchezok/synergy-plugin"
import { ProviderUsage } from "@/provider/usage-service"

type PluginAuth = NonNullable<PluginHooks["auth"]>

/**
 * Handle plugin-based authentication flow.
 * Returns true if auth was handled, false if it should fall through to default handling.
 */
async function handlePluginAuth(plugin: { auth: PluginAuth }, provider: string): Promise<boolean> {
  let index = 0
  if (plugin.auth.methods.length > 1) {
    const method = await prompts.select({
      message: "Login method",
      options: [
        ...plugin.auth.methods.map((x, index) => ({
          label: x.label,
          value: index.toString(),
        })),
      ],
    })
    if (prompts.isCancel(method)) throw new UI.CancelledError()
    index = parseInt(method)
  }
  const method = plugin.auth.methods[index]

  // Handle prompts for all auth types
  await Bun.sleep(10)
  const inputs: Record<string, string> = {}
  if (method.prompts) {
    for (const prompt of method.prompts) {
      if (prompt.condition && !prompt.condition(inputs)) {
        continue
      }
      if (prompt.type === "select") {
        const value = await prompts.select({
          message: prompt.message,
          options: prompt.options,
        })
        if (prompts.isCancel(value)) throw new UI.CancelledError()
        inputs[prompt.key] = value
      } else {
        const value = await prompts.text({
          message: prompt.message,
          placeholder: prompt.placeholder,
          validate: prompt.validate ? (v) => prompt.validate!(v ?? "") : undefined,
        })
        if (prompts.isCancel(value)) throw new UI.CancelledError()
        inputs[prompt.key] = value
      }
    }
  }

  if (method.type === "oauth") {
    const authorize = await method.authorize(inputs)

    if (authorize.url) {
      prompts.log.info("Go to: " + authorize.url)
    }

    if (authorize.method === "auto") {
      if (authorize.instructions) {
        prompts.log.info(authorize.instructions)
      }
      const spinner = prompts.spinner()
      spinner.start("Waiting for authorization...")
      const result = await authorize.callback()
      if (result.type === "failed") {
        spinner.stop("Failed to authorize", 1)
      }
      if (result.type === "success") {
        const saveProvider = result.provider ?? provider
        if ("refresh" in result) {
          const { type: _, provider: __, refresh, access, expires, ...extraFields } = result
          await Auth.set(saveProvider, {
            type: "oauth",
            refresh,
            access,
            expires,
            ...extraFields,
          })
        }
        if ("key" in result) {
          await Auth.set(saveProvider, {
            type: "api",
            key: result.key,
          })
        }
        spinner.stop("Login successful")
      }
    }

    if (authorize.method === "code") {
      const code = await prompts.text({
        message: "Paste the authorization code here: ",
        validate: (x) => (x && x.length > 0 ? undefined : "Required"),
      })
      if (prompts.isCancel(code)) throw new UI.CancelledError()
      const result = await authorize.callback(code)
      if (result.type === "failed") {
        prompts.log.error("Failed to authorize")
      }
      if (result.type === "success") {
        const saveProvider = result.provider ?? provider
        if ("refresh" in result) {
          const { type: _, provider: __, refresh, access, expires, ...extraFields } = result
          await Auth.set(saveProvider, {
            type: "oauth",
            refresh,
            access,
            expires,
            ...extraFields,
          })
        }
        if ("key" in result) {
          await Auth.set(saveProvider, {
            type: "api",
            key: result.key,
          })
        }
        prompts.log.success("Login successful")
      }
    }

    prompts.outro("Done")
    return true
  }

  if (method.type === "api") {
    if (method.authorize) {
      const result = await method.authorize(inputs)
      if (result.type === "failed") {
        prompts.log.error("Failed to authorize")
      }
      if (result.type === "success") {
        const saveProvider = result.provider ?? provider
        await Auth.set(saveProvider, {
          type: "api",
          key: result.key,
        })
        prompts.log.success("Login successful")
      }
      prompts.outro("Done")
      return true
    }
  }

  if (method.type === "import") {
    const result = await method.import(inputs)
    if (result.type === "failed") {
      prompts.log.error(result.message ?? "Failed to import credentials")
      prompts.outro("Done")
      return true
    }
    const saveProvider = result.provider ?? provider
    if ("refresh" in result) {
      await Auth.set(
        saveProvider,
        {
          type: "oauth",
          refresh: result.refresh,
          access: result.access,
          expires: result.expires,
        },
        { source: "import" },
      )
    } else {
      await Auth.set(saveProvider, { type: "api", key: result.key }, { source: "import" })
    }
    prompts.log.success("Credentials imported")
    prompts.outro("Done")
    return true
  }

  return false
}

async function handleCodexAuth(): Promise<boolean> {
  const existing = await CodexProvider.resolveToken({ allowMissing: true }).catch(() => undefined)
  if (existing) {
    const reuse = await prompts.confirm({
      message: "Existing OpenAI Codex credentials found. Use them?",
      initialValue: true,
    })
    if (prompts.isCancel(reuse)) throw new UI.CancelledError()
    if (reuse) {
      prompts.log.success("OpenAI Codex is already connected")
      prompts.outro("Done")
      return true
    }
  }

  const imported = await CodexProvider.importCodexCliAuth()
  if (imported) {
    prompts.log.info(`Found existing Codex CLI credentials at ${CodexProvider.codexHome()}/auth.json`)
    prompts.log.info("Synergy will copy them into its own credential store to avoid refresh-token conflicts.")
    const shouldImport = await prompts.confirm({
      message: "Import Codex CLI credentials?",
      initialValue: false,
    })
    if (prompts.isCancel(shouldImport)) throw new UI.CancelledError()
    if (shouldImport) {
      await CodexProvider.saveImportedToken(imported)
      prompts.log.success("OpenAI Codex credentials imported")
      prompts.outro("Done")
      return true
    }
  }

  const authorize = await CodexProvider.authorizeDeviceCode()
  if (authorize.method !== "auto") return false
  prompts.log.info("Open: " + authorize.url)
  prompts.log.info("Enter code: " + authorize.instructions)
  const spinner = prompts.spinner()
  spinner.start("Waiting for ChatGPT sign-in...")
  const result = await authorize.callback()
  if (result.type === "failed") {
    spinner.stop("Failed to authorize", 1)
    prompts.outro("Done")
    return true
  }
  if ("refresh" in result) {
    await Auth.set(
      CodexProvider.PROVIDER_ID,
      {
        type: "oauth",
        access: result.access,
        refresh: result.refresh,
        expires: result.expires,
      },
      { source: "cli" },
    )
  }
  spinner.stop("Login successful")
  prompts.outro("Done")
  return true
}

async function runOauthResult(provider: string, authorize: AuthOuathResult): Promise<boolean> {
  if (authorize.url) prompts.log.info("Open: " + authorize.url)
  if (authorize.instructions) prompts.log.info(authorize.instructions)

  if (authorize.method === "code") {
    const code = await prompts.text({
      message: "Paste the authorization code here: ",
      validate: (x) => (x && x.length > 0 ? undefined : "Required"),
    })
    if (prompts.isCancel(code)) throw new UI.CancelledError()
    const result = await authorize.callback(code)
    if (result.type === "failed") {
      prompts.log.error("Failed to authorize")
      prompts.outro("Done")
      return true
    }
    const saveProvider = result.provider ?? provider
    if ("refresh" in result) {
      await Auth.set(
        saveProvider,
        {
          type: "oauth",
          refresh: result.refresh,
          access: result.access,
          expires: result.expires,
        },
        { source: "cli" },
      )
    } else {
      await Auth.set(saveProvider, { type: "api", key: result.key }, { source: "cli" })
    }
    prompts.log.success("Login successful")
    prompts.outro("Done")
    return true
  }

  const spinner = prompts.spinner()
  spinner.start("Waiting for authorization...")
  const result = await authorize.callback()
  if (result.type === "failed") {
    spinner.stop("Failed to authorize", 1)
    prompts.outro("Done")
    return true
  }
  const saveProvider = result.provider ?? provider
  if ("refresh" in result) {
    await Auth.set(
      saveProvider,
      {
        type: "oauth",
        refresh: result.refresh,
        access: result.access,
        expires: result.expires,
      },
      { source: "cli" },
    )
  } else {
    await Auth.set(saveProvider, { type: "api", key: result.key }, { source: "cli" })
  }
  spinner.stop("Login successful")
  prompts.outro("Done")
  return true
}

async function handleBuiltinAuth(provider: string): Promise<boolean> {
  if (provider === AnthropicOAuthProvider.PROVIDER_ID) {
    const method = await prompts.select({
      message: "Login method",
      options: [
        { label: "Claude Pro/Max OAuth", value: "oauth", hint: "Uses Claude subscription OAuth" },
        { label: "Anthropic API key", value: "api", hint: "Uses Platform API billing" },
      ],
    })
    if (prompts.isCancel(method)) throw new UI.CancelledError()
    if (method === "api") return false
    return runOauthResult(provider, await AnthropicOAuthProvider.authorizeOAuth())
  }

  if (provider === CopilotProvider.PROVIDER_ID || provider === CopilotProvider.ENTERPRISE_PROVIDER_ID) {
    const method = await prompts.select({
      message: "Login method",
      options: [
        { label: "GitHub device login", value: "oauth", hint: "Uses GitHub Copilot subscription" },
        { label: "GitHub token", value: "api", hint: "Stores an existing token" },
      ],
    })
    if (prompts.isCancel(method)) throw new UI.CancelledError()
    if (method === "api") return false
    return runOauthResult(provider, await CopilotProvider.authorizeDeviceCode(provider))
  }

  if (provider === MiniMaxProvider.PROVIDER_ID) {
    return runOauthResult(provider, await MiniMaxProvider.authorizeOAuth())
  }

  return false
}

export const AuthCommand = cmd({
  command: "auth",
  describe: "manage credentials",
  builder: (yargs) =>
    yargs
      .command(AuthLoginCommand)
      .command(AuthLogoutCommand)
      .command(AuthListCommand)
      .command(AuthUsageCommand)
      .demandCommand(),
  async handler() {},
})

export const AuthUsageCommand = cmd({
  command: "usage [provider]",
  describe: "show provider account usage and quota windows",
  builder: (yargs) =>
    yargs.positional("provider", {
      describe: "provider ID",
      type: "string",
    }),
  async handler(args) {
    await ScopeContext.provide({
      scope: Scope.home(),
      async fn() {
        const snapshots = args.provider
          ? { [args.provider]: await ProviderUsage.get(args.provider) }
          : await ProviderUsage.all()
        for (const [providerID, snapshot] of Object.entries(snapshots)) {
          prompts.intro(providerID)
          if (snapshot.status !== "available") {
            prompts.log.warn(snapshot.unavailableReason ?? "Usage unavailable")
            prompts.outro("Done")
            continue
          }
          if (snapshot.plan) prompts.log.info(`Plan: ${snapshot.plan}`)
          for (const window of snapshot.windows) {
            const parts = [`${window.label}: ${window.usedPercent?.toFixed(1) ?? "?"}% used`]
            if (window.remainingPercent !== undefined) parts.push(`${window.remainingPercent.toFixed(1)}% remaining`)
            if (window.resetAt) parts.push(`resets ${window.resetAt}`)
            if (window.detail) parts.push(window.detail)
            prompts.log.info(parts.join(" • "))
          }
          for (const detail of snapshot.details) prompts.log.info(detail)
          prompts.outro(snapshot.source ?? "usage")
        }
      },
    })
  },
})

export const AuthListCommand = cmd({
  command: "list",
  aliases: ["ls"],
  describe: "list providers",
  async handler() {
    UI.empty()
    const authPath = Global.Path.authProvider
    const homedir = os.homedir()
    const displayPath = authPath.startsWith(homedir) ? authPath.replace(homedir, "~") : authPath
    prompts.intro(`Credentials ${UI.Style.TEXT_DIM}${displayPath}`)
    const results = Object.entries(await Auth.all())
    const database = await ProviderCatalog.resolve()

    for (const [providerID, result] of results) {
      const name = database[providerID]?.name || providerID
      prompts.log.info(`${name} ${UI.Style.TEXT_DIM}${result.type}`)
    }

    prompts.outro(`${results.length} credentials`)

    // Environment variables section
    const activeEnvVars: Array<{ provider: string; envVar: string }> = []

    for (const [providerID, provider] of Object.entries(database)) {
      for (const envVar of provider.env) {
        if (process.env[envVar]) {
          activeEnvVars.push({
            provider: provider.name || providerID,
            envVar,
          })
        }
      }
    }

    if (activeEnvVars.length > 0) {
      UI.empty()
      prompts.intro("Environment")

      for (const { provider, envVar } of activeEnvVars) {
        prompts.log.info(`${provider} ${UI.Style.TEXT_DIM}${envVar}`)
      }

      prompts.outro(`${activeEnvVars.length} environment variable` + (activeEnvVars.length === 1 ? "" : "s"))
    }
  },
})

export const AuthLoginCommand = cmd({
  command: "login [url]",
  describe: "log in to a provider",
  builder: (yargs) =>
    yargs.positional("url", {
      describe: "synergy auth provider",
      type: "string",
    }),
  async handler(args) {
    await ScopeContext.provide({
      scope: Scope.home(),
      async fn() {
        UI.empty()
        prompts.intro("Add credential")
        if (args.url) {
          const wellknown = await fetch(`${args.url}/.well-known/synergy`).then((x) => x.json() as any)
          prompts.log.info(`Running \`${wellknown.auth.command.join(" ")}\``)
          const proc = Bun.spawn({
            cmd: wellknown.auth.command,
            stdout: "pipe",
          })
          const exit = await proc.exited
          if (exit !== 0) {
            prompts.log.error("Failed")
            prompts.outro("Done")
            return
          }
          const token = await new Response(proc.stdout).text()
          await Auth.set(args.url, {
            type: "wellknown",
            key: wellknown.auth.env,
            token: token.trim(),
          })
          prompts.log.success("Logged into " + args.url)
          prompts.outro("Done")
          return
        }
        await ModelsDev.refresh()?.catch(() => {})

        const config = await Config.current()

        const disabled = new Set(config.disabled_providers ?? [])
        const enabled = config.enabled_providers ? new Set(config.enabled_providers) : undefined

        const providers = await ProviderCatalog.resolve({ config }).then((x) => {
          const filtered: Record<string, (typeof x)[string]> = {}
          for (const [key, value] of Object.entries(x)) {
            if ((enabled ? enabled.has(key) : true) && !disabled.has(key)) {
              filtered[key] = value
            }
          }
          return filtered
        })

        const priority: Record<string, number> = {
          anthropic: 1,
          [CodexProvider.PROVIDER_ID]: 2,
          "github-copilot": 3,
          openai: 4,
          google: 5,
          openrouter: 6,
          vercel: 7,
        }
        let provider = await prompts.autocomplete({
          message: "Select provider",
          maxItems: 8,
          options: [
            ...pipe(
              providers,
              values(),
              sortBy(
                (x) => priority[x.id] ?? 99,
                (x) => x.name ?? x.id,
              ),
              map((x) => ({
                label: x.name,
                value: x.id,
                hint: (
                  {
                    anthropic: "Claude Max or API key",
                    [CodexProvider.PROVIDER_ID]: "ChatGPT/Codex subscription",
                    [CopilotProvider.PROVIDER_ID]: "GitHub Copilot subscription",
                    [MiniMaxProvider.PROVIDER_ID]: "MiniMax OAuth",
                  } as Record<string, string | undefined>
                )[x.id],
              })),
            ),
            {
              value: "other",
              label: "Other",
            },
          ],
        })

        if (prompts.isCancel(provider)) throw new UI.CancelledError()

        if (provider === CodexProvider.PROVIDER_ID) {
          const handled = await handleCodexAuth()
          if (handled) return
        }

        if (
          provider === AnthropicOAuthProvider.PROVIDER_ID ||
          provider === CopilotProvider.PROVIDER_ID ||
          provider === CopilotProvider.ENTERPRISE_PROVIDER_ID ||
          provider === MiniMaxProvider.PROVIDER_ID
        ) {
          const handled = await handleBuiltinAuth(provider)
          if (handled) return
        }

        const plugin = await Plugin.allHooks().then((x) => x.find((x) => x.auth?.provider === provider))
        if (plugin && plugin.auth) {
          const handled = await handlePluginAuth({ auth: plugin.auth }, provider)
          if (handled) return
        }

        if (provider === "other") {
          provider = await prompts.text({
            message: "Enter provider id",
            validate: (x) => (x && x.match(/^[0-9a-z-]+$/) ? undefined : "a-z, 0-9 and hyphens only"),
          })
          if (prompts.isCancel(provider)) throw new UI.CancelledError()
          provider = provider.replace(/^@ai-sdk\//, "")
          if (prompts.isCancel(provider)) throw new UI.CancelledError()

          // Check if a plugin provides auth for this custom provider
          const customPlugin = await Plugin.allHooks().then((x) => x.find((x) => x.auth?.provider === provider))
          if (customPlugin && customPlugin.auth) {
            const handled = await handlePluginAuth({ auth: customPlugin.auth }, provider)
            if (handled) return
          }

          prompts.log.warn(
            `This only stores a credential for ${provider} - you will need configure it in synergy.json, check the docs for examples.`,
          )
        }

        if (provider === "amazon-bedrock") {
          prompts.log.info(
            "Amazon Bedrock authentication priority:\n" +
              "  1. Bearer token (AWS_BEARER_TOKEN_BEDROCK or /connect)\n" +
              "  2. AWS credential chain (profile, access keys, IAM roles)\n\n" +
              "Configure via synergy.json options (profile, region, endpoint) or\n" +
              "AWS environment variables (AWS_PROFILE, AWS_REGION, AWS_ACCESS_KEY_ID).",
          )
          prompts.outro("Done")
          return
        }

        if (provider === "vercel") {
          prompts.log.info("You can create an api key at https://vercel.link/ai-gateway-token")
        }

        if (["cloudflare", "cloudflare-ai-gateway"].includes(provider)) {
          prompts.log.info(
            "Cloudflare AI Gateway can be configured with CLOUDFLARE_GATEWAY_ID, CLOUDFLARE_ACCOUNT_ID, and CLOUDFLARE_API_TOKEN environment variables. Read more: https://synergy.holosai.io/docs/providers/#cloudflare-ai-gateway",
          )
        }

        const key = await prompts.password({
          message: "Enter your API key",
          validate: (x) => (x && x.length > 0 ? undefined : "Required"),
        })
        if (prompts.isCancel(key)) throw new UI.CancelledError()
        await Auth.set(
          provider,
          {
            type: "api",
            key,
          },
          { source: "cli" },
        )

        prompts.outro("Done")
      },
    })
  },
})

export const AuthLogoutCommand = cmd({
  command: "logout",
  describe: "log out from a configured provider",
  async handler() {
    UI.empty()
    const credentials = await Auth.all().then((x) => Object.entries(x))
    prompts.intro("Remove credential")
    if (credentials.length === 0) {
      prompts.log.error("No credentials found")
      return
    }
    const database = await ProviderCatalog.resolve()
    const providerID = await prompts.select({
      message: "Select provider",
      options: credentials.map(([key, value]) => ({
        label: (database[key]?.name || key) + UI.Style.TEXT_DIM + " (" + value.type + ")",
        value: key,
      })),
    })
    if (prompts.isCancel(providerID)) throw new UI.CancelledError()
    await Auth.remove(providerID)
    prompts.outro("Logout successful")
  },
})
