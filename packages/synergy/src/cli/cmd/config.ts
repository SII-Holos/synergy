import { Auth } from "../../provider/api-key"
import { ModelsDev } from "../../provider/models"
import path from "path"
import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
import { UI } from "../ui"
import { Config } from "../../config/config"
import { Global } from "../../global"
import { ConfigSet } from "../../config/set"
import { SetupService } from "../../setup/service"
import { ConfigSetup } from "../../config/setup"

export const ConfigCommand = cmd({
  command: "config",
  describe: "manage synergy configuration",
  builder: (yargs) =>
    yargs
      .command(ConfigEditCommand)
      .command(ConfigPathCommand)
      .command(ConfigImportCommand)
      .command(ConfigEmbeddingCommand)
      .command(ConfigRerankCommand)
      .command(ConfigWizardCommand),
  async handler() {},
})

export const ConfigEditCommand = cmd({
  command: "edit",
  describe: "open global config file in editor",
  builder: (yargs) =>
    yargs.option("editor", {
      type: "string",
      alias: "e",
      describe: "editor to use (default: $EDITOR or code)",
    }),
  async handler(args) {
    const filepath = ConfigSet.filePath(ConfigSet.activeNameSync())

    // Ensure file exists
    const file = Bun.file(filepath)
    if (!(await file.exists())) {
      await Bun.write(filepath, "{}\n")
    }

    const editor = args.editor || process.env.EDITOR || "code"
    const editorArgs = editor === "code" ? ["--wait"] : []

    UI.empty()
    prompts.intro("Edit Config")
    prompts.log.info(`Opening ${filepath}`)

    const proc = Bun.spawn([editor, ...editorArgs, filepath], {
      stdio: ["inherit", "inherit", "inherit"],
    })

    await proc.exited
    prompts.outro("Done")
  },
})

export const ConfigPathCommand = cmd({
  command: "path",
  describe: "show config file paths",
  async handler() {
    UI.empty()
    prompts.intro("Config Paths")
    const active = ConfigSet.activeNameSync()
    prompts.log.info(`Active global Config Set: ${active}`)
    prompts.log.info(`Active global config:     ${ConfigSet.filePath(active)}`)
    prompts.log.info(`Default Config Set:       ${ConfigSet.defaultFilePath()}`)
    prompts.log.info(`Config Sets root:         ${ConfigSet.directory()}`)
    prompts.log.info(`Config Set metadata:      ${ConfigSet.metadataPath()}`)
    prompts.log.info(`Global data:              ${Global.Path.data}`)
    prompts.log.info(`Global cache:             ${Global.Path.cache}`)
    prompts.outro("Done")
  },
})

function FormatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }
  return String(error)
}

async function importConfigFromURL(input: { url: string; probe: boolean; force: boolean }) {
  const { url, probe, force } = input

  UI.empty()
  const spinner = prompts.spinner()
  spinner.start("Downloading config...")

  try {
    spinner.message(`Downloading: ${url}`)
    const config = await ConfigSetup.downloadConfigFromURL(url)
    spinner.stop("✓ Config downloaded")

    spinner.start("Validating config...")
    const validation = await SetupService.validateImport(config)
    if (!validation.valid || !validation.config) {
      spinner.stop("✗ Validation failed")
      prompts.log.error("Config validation failed:")
      for (const warning of validation.warnings) {
        prompts.log.error(`  - ${warning}`)
      }
      return
    }
    spinner.stop("✓ Config validated")

    if (probe) {
      spinner.start("Running connectivity probes...")
      const probeResult = await SetupService.probeImport(config)
      spinner.stop("✓ Probes completed")

      if (!probeResult.valid) {
        prompts.log.warn("Some probes failed:")
        for (const [field, result] of Object.entries(probeResult.fields) as Array<
          [ConfigSetup.RequiredCoreField, ConfigSetup.FieldValidationResult]
        >) {
          if (!result.valid) {
            prompts.log.warn(`  - ${field}: ${result.message}`)
          }
        }

        if (!force) {
          const proceed = await prompts.confirm({
            message: "Probes failed. Continue with import?",
            initialValue: false,
          })
          if (proceed !== true) {
            prompts.cancel("Import cancelled")
            return
          }
        }
      }

      // Show warnings for recommended fields that were skipped due to validation failure
      const failedRecommended = Object.entries(probeResult.fields).filter(
        ([, result]) => result.failedRecommended,
      ) as Array<[ConfigSetup.RequiredCoreField, ConfigSetup.FieldValidationResult]>
      if (failedRecommended.length > 0) {
        prompts.log.warn("Some recommended models could not be verified and will be skipped:")
        for (const [field, result] of failedRecommended) {
          prompts.log.warn(`  - ${field}: ${result.message}`)
        }
      }
    }

    prompts.intro("Import Config from URL")
    prompts.log.info(`URL: ${url}`)
    if (validation.providers && validation.providers.length > 0) {
      prompts.log.info(`Providers: ${validation.providers.join(", ")}`)
    }
    if (validation.roles && Object.keys(validation.roles).length > 0) {
      for (const [role, model] of Object.entries(validation.roles)) {
        prompts.log.info(`${role}: ${model}`)
      }
    }

    if (!force) {
      UI.empty()
      const confirm = await prompts.confirm({
        message: "Ready to import. Continue?",
        initialValue: true,
      })
      if (confirm !== true) {
        prompts.cancel("Import cancelled")
        return
      }
    }

    spinner.start("Importing config...")
    const filepath = await SetupService.importConfig(config)
    spinner.stop("✓ Config imported")

    prompts.log.success(`Config imported to ${filepath}`)
    prompts.outro("Done")
  } catch (error) {
    spinner.stop("✗ Import failed")
    UI.error(FormatError(error))
  }
}

export const ConfigImportCommand = cmd({
  command: "import <url>",
  describe: "import config from URL",
  builder: (yargs) =>
    yargs
      .positional("url", {
        type: "string",
        demandOption: true,
        describe: "URL to download config from",
      })
      .option("probe", {
        type: "boolean",
        default: true,
        describe: "Run live connectivity probes",
      })
      .option("no-probe", {
        type: "boolean",
        describe: "Skip live connectivity probes (alias for --probe=false)",
      })
      .option("force", {
        type: "boolean",
        alias: "f",
        default: false,
        describe: "Skip confirmation prompts",
      }),
  async handler(args) {
    await importConfigFromURL({
      url: args.url as string,
      probe: args.noProbe ? false : args.probe,
      force: args.force as boolean,
    })
  },
})
export const ConfigEmbeddingCommand = cmd({
  command: "embedding",
  describe: "configure embedding provider (writes to global config)",
  builder: (yargs) =>
    yargs.option("print", {
      type: "boolean",
      describe: "print config instead of writing to file",
    }),
  async handler(args) {
    UI.empty()
    prompts.intro("Configure Embedding Provider")

    const baseURL = await prompts.text({
      message: "Embedding API base URL",
      placeholder: "https://api.siliconflow.cn/v1",
      initialValue: "https://api.siliconflow.cn/v1",
    })
    if (prompts.isCancel(baseURL)) throw new UI.CancelledError()

    const model = await prompts.text({
      message: "Embedding model name",
      placeholder: "Qwen/Qwen3-Embedding-8B",
      initialValue: "Qwen/Qwen3-Embedding-8B",
    })
    if (prompts.isCancel(model)) throw new UI.CancelledError()

    const useEnv = await prompts.confirm({
      message: "Store API key in environment variable?",
      initialValue: true,
    })
    if (prompts.isCancel(useEnv)) throw new UI.CancelledError()

    const apiKey = useEnv
      ? "{env:SYNERGY_EMBEDDING_KEY}"
      : await (async () => {
          const key = await prompts.password({
            message: "Embedding API key",
            validate: (x) => (x && x.length > 0 ? undefined : "Required"),
          })
          if (prompts.isCancel(key)) throw new UI.CancelledError()
          return key
        })()

    const config = {
      embedding: { baseURL, model, apiKey },
    } as any as Config.Info

    if (args.print) {
      prompts.log.success("Embedding configured!")
      prompts.log.info("Add this to your config file:")
      prompts.log.message(JSON.stringify(config, null, 2))
    } else {
      await Config.updateGlobal(config)
      prompts.log.success("Embedding configuration saved to the active global Config Set")
      prompts.log.info(`Config file: ${await Config.globalPath()}`)
    }

    if (useEnv) {
      UI.empty()
      prompts.log.info("Set the environment variable:")
      prompts.log.message(`export SYNERGY_EMBEDDING_KEY="your-api-key"`)
    }

    prompts.outro("Done")
  },
})

export const ConfigRerankCommand = cmd({
  command: "rerank",
  describe: "configure rerank provider (writes to global config)",
  builder: (yargs) =>
    yargs.option("print", {
      type: "boolean",
      describe: "print config instead of writing to file",
    }),
  async handler(args) {
    UI.empty()
    prompts.intro("Configure Rerank Provider")

    const baseURL = await prompts.text({
      message: "Rerank API base URL",
      placeholder: "https://api.siliconflow.cn/v1",
      initialValue: "https://api.siliconflow.cn/v1",
    })
    if (prompts.isCancel(baseURL)) throw new UI.CancelledError()

    const model = await prompts.text({
      message: "Rerank model name",
      placeholder: "Qwen/Qwen3-Reranker-8B",
      initialValue: "Qwen/Qwen3-Reranker-8B",
    })
    if (prompts.isCancel(model)) throw new UI.CancelledError()

    const useEnv = await prompts.confirm({
      message: "Store API key in environment variable?",
      initialValue: true,
    })
    if (prompts.isCancel(useEnv)) throw new UI.CancelledError()

    const apiKey = useEnv
      ? "{env:SYNERGY_RERANK_KEY}"
      : await (async () => {
          const key = await prompts.password({
            message: "Rerank API key",
            validate: (x) => (x && x.length > 0 ? undefined : "Required"),
          })
          if (prompts.isCancel(key)) throw new UI.CancelledError()
          return key
        })()

    const config = {
      rerank: { baseURL, model, apiKey },
    } as any as Config.Info

    if (args.print) {
      prompts.log.success("Rerank configured!")
      prompts.log.info("Add this to your config file:")
      prompts.log.message(JSON.stringify(config, null, 2))
    } else {
      await Config.updateGlobal(config)
      prompts.log.success("Rerank configuration saved to the active global Config Set")
      prompts.log.info(`Config file: ${await Config.globalPath()}`)
    }

    if (useEnv) {
      UI.empty()
      prompts.log.info("Set the environment variable:")
      prompts.log.message(`export SYNERGY_RERANK_KEY="your-api-key"`)
    }

    prompts.outro("Done")
  },
})
// ── Provider env-var detection ──

const FEATURED_PROVIDERS = ["anthropic", "openai", "google", "deepseek"] as const

const PROVIDER_ENV_MAP: Record<string, { name: string; envVars: string[]; defaultModel: string }> = {
  anthropic: { name: "Anthropic", envVars: ["ANTHROPIC_API_KEY"], defaultModel: "claude-sonnet-4-5" },
  openai: { name: "OpenAI", envVars: ["OPENAI_API_KEY"], defaultModel: "gpt-4o" },
  google: { name: "Google", envVars: ["GEMINI_API_KEY", "GOOGLE_API_KEY"], defaultModel: "gemini-2.5-flash" },
  deepseek: { name: "DeepSeek", envVars: ["DEEPSEEK_API_KEY"], defaultModel: "deepseek-chat" },
  groq: { name: "Groq", envVars: ["GROQ_API_KEY"], defaultModel: "llama-4-scout-17b-16e-instruct" },
  openrouter: { name: "OpenRouter", envVars: ["OPENROUTER_API_KEY"], defaultModel: "openai/gpt-4o" },
  xai: { name: "xAI", envVars: ["XAI_API_KEY"], defaultModel: "grok-3" },
  siliconflow: { name: "SiliconFlow", envVars: ["SILICONFLOW_API_KEY"], defaultModel: "Qwen/Qwen3-235B-A22B" },
  mistral: { name: "Mistral", envVars: ["MISTRAL_API_KEY"], defaultModel: "mistral-large-latest" },
  cerebras: { name: "Cerebras", envVars: ["CEREBRAS_API_KEY"], defaultModel: "llama-4-scout-17b-16e-instruct" },
  deepinfra: {
    name: "DeepInfra",
    envVars: ["DEEPINFRA_API_KEY"],
    defaultModel: "meta-llama/Meta-Llama-3.3-70B-Instruct",
  },
  perplexity: { name: "Perplexity", envVars: ["PERPLEXITY_API_KEY"], defaultModel: "sonar-pro" },
  togetherai: {
    name: "Together AI",
    envVars: ["TOGETHER_API_KEY"],
    defaultModel: "meta-llama/Meta-Llama-3.3-70B-Instruct-Turbo",
  },
  cohere: { name: "Cohere", envVars: ["COHERE_API_KEY"], defaultModel: "command-r-plus" },
  vercel: { name: "Vercel", envVars: ["AI_GATEWAY_API_KEY", "VERCEL_API_KEY"], defaultModel: "gpt-4o" },
}

interface DetectedProvider {
  providerID: string
  providerName: string
  envVars: string[]
  detected: boolean
  defaultModel: string
}

function detectProviders(): DetectedProvider[] {
  const results: DetectedProvider[] = []
  const seenProviderIDs = new Set<string>()

  // Featured providers first in order
  for (const providerID of FEATURED_PROVIDERS) {
    seenProviderIDs.add(providerID)
    const info = PROVIDER_ENV_MAP[providerID]
    if (!info) continue
    const detected = info.envVars.some((v) => Boolean(process.env[v]))
    results.push({
      providerID,
      providerName: info.name,
      envVars: info.envVars,
      detected,
      defaultModel: info.defaultModel,
    })
  }

  // Remaining providers sorted alphabetically
  const remaining = Object.keys(PROVIDER_ENV_MAP)
    .filter((id) => !seenProviderIDs.has(id))
    .sort()

  for (const providerID of remaining) {
    const info = PROVIDER_ENV_MAP[providerID]
    const detected = info.envVars.some((v) => Boolean(process.env[v]))
    results.push({
      providerID,
      providerName: info.name,
      envVars: info.envVars,
      detected,
      defaultModel: info.defaultModel,
    })
  }

  return results
}

// ── Config Wizard ──

export async function runConfigWizard() {
  UI.empty()
  prompts.intro("Synergy Config Wizard")

  const detected = detectProviders()
  const detectedEnv = detected.filter((p) => p.detected)
  const notDetected = detected.filter((p) => !p.detected)

  // Step 1: Show env-var detection results
  prompts.log.info("Scanning environment for available AI providers...")

  if (detectedEnv.length > 0) {
    prompts.log.info("")
    prompts.log.info("Detected available AI providers from environment:")
    prompts.log.info("")
    for (const provider of detected) {
      const icon = provider.detected ? "●" : "○"
      const model = provider.detected ? `→ ${provider.defaultModel}` : "(not detected)"
      const dim = provider.detected ? "" : UI.Style.TEXT_DIM
      prompts.log.info(`  ${icon} ${provider.providerName.padEnd(13)} ${dim}(${provider.envVars.join(", ")})  ${model}`)
    }

    prompts.log.info("")

    const action = await prompts.select({
      message: "What would you like to do?",
      options: [
        { value: "use-detected", label: "Use detected providers", hint: `configure ${detectedEnv.length} detected` },
        { value: "add-another", label: "Add another provider", hint: "enter API key for any provider" },
        { value: "advanced", label: "Advanced setup", hint: "configure all options" },
      ],
      initialValue: "use-detected",
    })
    if (prompts.isCancel(action)) {
      prompts.outro("Setup cancelled")
      return false
    }

    if (action === "use-detected") {
      return await useDetectedProviders(detectedEnv)
    }
    if (action === "add-another") {
      return await manualProviderSelection()
    }
    if (action === "advanced") {
      return await advancedConfig()
    }
  } else {
    // No env vars detected — go straight to provider selection
    prompts.log.warn("No API keys detected in environment.")
    prompts.log.info("Configure a provider to get started:")
    prompts.log.info("")
    return await manualProviderSelection()
  }
}

async function useDetectedProviders(detectedEnv: DetectedProvider[]): Promise<boolean> {
  // Pick first detected as default model
  const primary = detectedEnv[0]

  const modelString = `${primary.providerID}/${primary.defaultModel}`

  UI.empty()
  prompts.intro("Confirm Setup")

  prompts.log.info("Synergy will use:")
  prompts.log.info("")
  prompts.log.info(`  Default model:  ${modelString}`)
  prompts.log.info(`  Embedding:      Xenova/all-MiniLM-L6-v2 (local, automatic)`)
  prompts.log.info(`  Vision model:   not configured (look_at will show a helpful error)`)
  prompts.log.info("")

  const confirm = await prompts.confirm({
    message: "Confirm and save?",
    initialValue: true,
  })
  if (prompts.isCancel(confirm) || !confirm) {
    prompts.outro("Setup cancelled")
    return false
  }

  const spinner = prompts.spinner()
  spinner.start("Saving configuration...")

  try {
    // Save API keys for all detected providers
    for (const provider of detectedEnv) {
      const apiKey = provider.envVars.reduce<string | undefined>(
        (found, v) => found ?? process.env[v] ?? undefined,
        undefined,
      )
      if (apiKey) {
        await Auth.set(provider.providerID, { type: "api", key: apiKey })
      }
    }

    // Write minimal config with the model
    await Config.updateGlobal({ model: modelString } as Config.Info)

    spinner.stop("✓ Configuration saved")

    prompts.log.success(`Default model set to ${modelString}`)
    prompts.log.info(`Config file: ${ConfigSet.defaultFilePath()}`)
    prompts.outro("Done")
    return true
  } catch (error) {
    spinner.stop("✗ Failed to save configuration")
    UI.error(FormatError(error))
    prompts.outro("Setup failed")
    return false
  }
}

async function manualProviderSelection(selectedCount = 0): Promise<boolean> {
  const allProviders = Object.entries(PROVIDER_ENV_MAP).sort(([, a], [, b]) => a.name.localeCompare(b.name))

  const options = allProviders.map(([id, info]) => ({
    value: id,
    label: info.name,
    hint: info.defaultModel,
  }))

  options.unshift(
    ...FEATURED_PROVIDERS.map((id) => {
      const info = PROVIDER_ENV_MAP[id]
      const idx = options.findIndex((o) => o.value === id)
      if (idx >= 1) {
        options.splice(idx, 1)
      }
      // Remove from original position to re-add at top
      return { value: id, label: `✦ ${info.name}`, hint: info.defaultModel }
    }),
  )

  // Deduplicate: featured providers already moved to top
  const seen = new Set<string>()
  const uniqueOptions = options.filter((o) => {
    if (seen.has(o.value)) return false
    seen.add(o.value)
    return true
  })

  UI.empty()
  prompts.intro(selectedCount > 0 ? "Add Another Provider" : "Select a Provider")

  const providerID = await prompts.select({
    message: "Choose an AI provider:",
    options: uniqueOptions.map((o) => ({
      value: o.value,
      label: o.label,
      hint: o.hint,
    })),
    initialValue: FEATURED_PROVIDERS[0],
  })
  if (prompts.isCancel(providerID)) {
    prompts.outro("Setup cancelled")
    return false
  }
  const providerInfo = PROVIDER_ENV_MAP[providerID as string]
  if (!providerInfo) {
    prompts.outro("Unknown provider")
    return false
  }

  // Check if env var is already set
  const envKey = providerInfo.envVars.find((v) => Boolean(process.env[v]))
  let apiKey = ""
  if (envKey) {
    prompts.log.info(`${providerInfo.name} key found in ${envKey}`)
  } else {
    const key = await prompts.password({
      message: `${providerInfo.name} API key:`,
      validate: (x) => (x && x.length > 0 ? undefined : "Required"),
    })
    if (prompts.isCancel(key)) {
      prompts.outro("Setup cancelled")
      return false
    }
    apiKey = key as string
  }

  const modelString = `${providerID}/${providerInfo.defaultModel}`

  const spinner = prompts.spinner()
  spinner.start("Saving configuration...")

  try {
    if (apiKey) {
      await Auth.set(providerID as string, { type: "api", key: apiKey })
    }

    if (selectedCount === 0) {
      await Config.updateGlobal({ model: modelString } as Config.Info)
    } else {
      const existing = await Config.get().catch(() => ({}) as Config.Info)
      if (!existing.model) {
        await Config.updateGlobal({ model: modelString } as Config.Info)
      }
    }

    spinner.stop("✓ Provider configured")

    prompts.log.success(`${providerInfo.name} configured — default model: ${modelString}`)
    prompts.log.info(`Config file: ${ConfigSet.defaultFilePath()}`)

    const addAnother = await prompts.confirm({
      message: "Add another provider?",
      initialValue: false,
    })
    if (prompts.isCancel(addAnother)) {
      prompts.outro("Done")
      return true
    }
    if (addAnother) {
      return await manualProviderSelection(selectedCount + 1)
    }

    prompts.outro("Done")
    return true
  } catch (error) {
    spinner.stop("✗ Failed to save configuration")
    UI.error(FormatError(error))
    prompts.outro("Setup failed")
    return false
  }
}

async function advancedConfig(): Promise<boolean> {
  UI.empty()
  prompts.intro("Advanced Configuration")

  const advancedAction = await prompts.select({
    message: "What would you like to configure?",
    options: [
      { value: "full", label: "Full interactive setup", hint: "configure everything step by step" },
      { value: "edit", label: "Open config file in editor", hint: "manually edit synergy.jsonc" },
    ],
    initialValue: "full",
  })
  if (prompts.isCancel(advancedAction)) {
    prompts.outro("Cancelled")
    return false
  }

  if (advancedAction === "edit") {
    prompts.log.info("Opening config editor...")
    await ConfigEditCommand.handler?.({ editor: undefined } as any)
    return true
  }

  // Full interactive setup: walk through core fields
  const primary = await prompts.select({
    message: "Select primary AI provider:",
    options: FEATURED_PROVIDERS.map((id) => {
      const info = PROVIDER_ENV_MAP[id]
      return { value: id, label: info.name, hint: info.defaultModel }
    }),
    initialValue: FEATURED_PROVIDERS[0],
  })
  if (prompts.isCancel(primary)) {
    prompts.outro("Cancelled")
    return false
  }
  const primaryInfo = PROVIDER_ENV_MAP[primary as string]

  const envKey = primaryInfo.envVars.find((v) => Boolean(process.env[v]))
  let apiKey = ""
  if (envKey) {
    prompts.log.info(`${primaryInfo.name} key found in ${envKey}`)
  } else {
    const key = await prompts.password({
      message: `${primaryInfo.name} API key:`,
      validate: (x) => (x && x.length > 0 ? undefined : "Required"),
    })
    if (prompts.isCancel(key)) {
      prompts.outro("Cancelled")
      return false
    }
    apiKey = key as string
  }

  // Optional: vision model
  const wantVision = await prompts.confirm({
    message: "Configure a vision model? (optional)",
    initialValue: false,
  })
  if (prompts.isCancel(wantVision)) {
    prompts.outro("Cancelled")
    return false
  }

  let visionModel = ""
  if (wantVision) {
    const vision = await prompts.text({
      message: "Vision model (e.g. anthropic/claude-sonnet-4-5):",
      placeholder: `${primary}/claude-sonnet-4-5`,
    })
    if (prompts.isCancel(vision)) {
      prompts.outro("Cancelled")
      return false
    }
    visionModel = vision as string
  }

  // Optional: model roles
  const wantRoles = await prompts.confirm({
    message: "Configure additional model roles? (nano, thinking, creative, etc.)",
    initialValue: false,
  })
  if (prompts.isCancel(wantRoles)) {
    prompts.outro("Cancelled")
    return false
  }

  const roleModels: Record<string, string> = {}
  if (wantRoles) {
    const roles = [
      { key: "nano_model", label: "Nano model (cheapest, for simple tasks)" },
      { key: "thinking_model", label: "Thinking model (for complex reasoning)" },
      { key: "creative_model", label: "Creative model (for writing)" },
      { key: "long_context_model", label: "Long context model (for large files)" },
    ]
    for (const role of roles) {
      const val = await prompts.text({
        message: `${role.label} — enter provider/model or empty to skip:`,
        placeholder: `${primary}/claude-sonnet-4-5`,
      })
      if (prompts.isCancel(val)) {
        prompts.outro("Cancelled")
        return false
      }
      if (val) roleModels[role.key] = val as string
    }
  }

  const modelString = `${primary}/${primaryInfo.defaultModel}`
  const configData: Record<string, unknown> = { model: modelString }
  if (visionModel) configData.vision_model = visionModel
  Object.assign(configData, roleModels)

  const spinner = prompts.spinner()
  spinner.start("Saving configuration...")

  try {
    if (apiKey) {
      await Auth.set(primary as string, { type: "api", key: apiKey })
    }
    await Config.updateGlobal(configData as Config.Info)
    spinner.stop("✓ Configuration saved")
    prompts.log.success("Advanced configuration saved")
    prompts.log.info(`Config file: ${ConfigSet.defaultFilePath()}`)
    prompts.outro("Done")
    return true
  } catch (error) {
    spinner.stop("✗ Failed to save configuration")
    UI.error(FormatError(error))
    prompts.outro("Setup failed")
    return false
  }
}

export const ConfigWizardCommand = cmd({
  command: "wizard",
  describe: "interactive config wizard — auto-detect and set up providers",
  async handler() {
    await runConfigWizard()
  },
})
