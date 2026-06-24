import { Auth } from "../../provider/api-key"
import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
import { UI } from "../ui"
import { Config } from "../../config/config"
import { Global } from "../../global"
import { ConfigSetup } from "../../config/setup"
import { ConfigDomain } from "../../config/domain"
import { parse as parseJsonc } from "jsonc-parser"

export const ConfigCommand = cmd({
  command: "config",
  describe: "manage synergy configuration",
  builder: (yargs) =>
    yargs
      .command(ConfigPathCommand)
      .command(ConfigImportCommand)
      .command(ConfigEmbeddingCommand)
      .command(ConfigRerankCommand)
      .command(ConfigWizardCommand),
  async handler() {},
})

export const ConfigPathCommand = cmd({
  command: "path",
  describe: "show config file paths",
  async handler() {
    UI.empty()
    prompts.intro("Config Paths")
    prompts.log.info(`Global config root:       ${Global.Path.config}`)
    prompts.log.info(`Global domain directory:  ${ConfigDomain.directory()}`)
    prompts.log.info(`Global data:              ${Global.Path.data}`)
    prompts.log.info(`Global cache:             ${Global.Path.cache}`)
    prompts.outro("Done")
  },
})

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }
  return String(error)
}

async function importConfigFromURL(input: {
  source: string
  only: ConfigDomain.Id[]
  mode?: ConfigDomain.MergeMode
  dryRun: boolean
  yes: boolean
}) {
  const { source, only, mode, dryRun, yes } = input

  UI.empty()
  const spinner = prompts.spinner()
  spinner.start("Loading config...")

  try {
    spinner.message(`Loading: ${source}`)
    const config = await loadImportSource(source)
    spinner.stop("✓ Config loaded")

    const selected = only.length > 0 ? only : ConfigDomain.definitions.map((domain) => domain.id)
    const plan = await Config.domainImportPlan({ config, only: selected, mode })

    prompts.intro("Import Config")
    prompts.log.info(`Source: ${source}`)
    for (const domain of plan.domains) {
      prompts.log.info(`${domain.id} -> ${domain.path}`)
      for (const change of domain.changes) {
        prompts.log.message(`  ${change.conflict ? "!" : "-"} ${change.key}`)
      }
    }
    if (plan.conflicts.length > 0) {
      prompts.log.warn(`${plan.conflicts.length} conflict(s) detected`)
    }
    if (dryRun) {
      prompts.outro("Dry run complete")
      return
    }

    if (!yes) {
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
    const applied = await Config.domainImportApply({ config, only: selected, mode, yes })
    spinner.stop("✓ Config imported")

    prompts.log.success(`Imported ${applied.domains.length} domain(s)`)
    prompts.outro("Done")
  } catch (error) {
    spinner.stop("✗ Import failed")
    UI.error(formatError(error))
  }
}

async function loadImportSource(source: string): Promise<Config.Info> {
  if (URL.canParse(source) && /^https?:/.test(new URL(source).protocol)) {
    return Config.Info.parse(await ConfigSetup.downloadConfigFromURL(source))
  }
  const text = await Bun.file(source).text()
  return Config.Info.parse(parseJsonc(text))
}

export const ConfigImportCommand = cmd({
  command: "import <source>",
  describe: "import config from URL or file",
  builder: (yargs) =>
    yargs
      .positional("source", {
        type: "string",
        demandOption: true,
        describe: "URL or file path to import config from",
      })
      .option("only", {
        type: "array",
        choices: ConfigDomain.Id.options,
        describe: "Import only this domain; can be repeated",
      })
      .option("mode", {
        type: "string",
        choices: ConfigDomain.MergeMode.options,
        describe: "Import merge mode",
      })
      .option("dry-run", {
        type: "boolean",
        default: false,
        describe: "Show import plan without writing files",
      })
      .option("yes", {
        type: "boolean",
        alias: "y",
        default: false,
        describe: "Apply without confirmation",
      }),
  async handler(args) {
    const only = args.only ? (Array.isArray(args.only) ? args.only : [args.only]) : []
    await importConfigFromURL({
      source: args.source as string,
      only: only.map((id) => ConfigDomain.Id.parse(id)),
      mode: args.mode ? ConfigDomain.MergeMode.parse(args.mode) : undefined,
      dryRun: Boolean(args.dryRun),
      yes: Boolean(args.yes),
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
      prompts.log.success("Embedding configuration saved")
      prompts.log.info(`Config file: ${ConfigDomain.filepath("general")}`)
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
      prompts.log.success("Rerank configuration saved")
      prompts.log.info(`Config file: ${ConfigDomain.filepath("general")}`)
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

interface ProviderEntry {
  name: string
  envVars: string[]
  defaultModel: string
  order: number
}

const PROVIDER_ENV_MAP: Record<string, ProviderEntry> = {
  anthropic: { name: "Anthropic", envVars: ["ANTHROPIC_API_KEY"], defaultModel: "claude-sonnet-4-5", order: 1 },
  openai: { name: "OpenAI", envVars: ["OPENAI_API_KEY"], defaultModel: "gpt-4o", order: 2 },
  google: { name: "Google", envVars: ["GEMINI_API_KEY", "GOOGLE_API_KEY"], defaultModel: "gemini-2.5-flash", order: 3 },
  deepseek: { name: "DeepSeek", envVars: ["DEEPSEEK_API_KEY"], defaultModel: "deepseek-chat", order: 4 },
  groq: { name: "Groq", envVars: ["GROQ_API_KEY"], defaultModel: "llama-4-scout-17b-16e-instruct", order: 10 },
  openrouter: { name: "OpenRouter", envVars: ["OPENROUTER_API_KEY"], defaultModel: "openai/gpt-4o", order: 11 },
  xai: { name: "xAI", envVars: ["XAI_API_KEY"], defaultModel: "grok-3", order: 12 },
  siliconflow: {
    name: "SiliconFlow",
    envVars: ["SILICONFLOW_API_KEY"],
    defaultModel: "Qwen/Qwen3-235B-A22B",
    order: 13,
  },
  mistral: { name: "Mistral", envVars: ["MISTRAL_API_KEY"], defaultModel: "mistral-large-latest", order: 14 },
  cerebras: {
    name: "Cerebras",
    envVars: ["CEREBRAS_API_KEY"],
    defaultModel: "llama-4-scout-17b-16e-instruct",
    order: 15,
  },
  deepinfra: {
    name: "DeepInfra",
    envVars: ["DEEPINFRA_API_KEY"],
    defaultModel: "meta-llama/Meta-Llama-3.3-70B-Instruct",
    order: 16,
  },
  perplexity: { name: "Perplexity", envVars: ["PERPLEXITY_API_KEY"], defaultModel: "sonar-pro", order: 17 },
  togetherai: {
    name: "Together AI",
    envVars: ["TOGETHER_API_KEY"],
    defaultModel: "meta-llama/Meta-Llama-3.3-70B-Instruct-Turbo",
    order: 18,
  },
  cohere: { name: "Cohere", envVars: ["COHERE_API_KEY"], defaultModel: "command-r-plus", order: 19 },
  vercel: { name: "Vercel", envVars: ["AI_GATEWAY_API_KEY", "VERCEL_API_KEY"], defaultModel: "gpt-4o", order: 20 },
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

  for (const [providerID, info] of Object.entries(PROVIDER_ENV_MAP)) {
    const detected = info.envVars.some((v) => Boolean(process.env[v]))
    results.push({
      providerID,
      providerName: info.name,
      envVars: info.envVars,
      detected,
      defaultModel: info.defaultModel,
    })
  }

  results.sort((a, b) => {
    const infoA = PROVIDER_ENV_MAP[a.providerID]
    const infoB = PROVIDER_ENV_MAP[b.providerID]
    return infoA.order - infoB.order || a.providerName.localeCompare(b.providerName)
  })

  return results
}

// ── Config saver helper ──

async function saveConfig(spinner: ReturnType<typeof prompts.spinner>, fn: () => Promise<void>): Promise<boolean> {
  try {
    await fn()
    return true
  } catch (error) {
    spinner.stop("✗ Failed to save configuration")
    UI.error(formatError(error))
    prompts.outro("Setup failed")
    return false
  }
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
      let selectedProvider: string
      if (detectedEnv.length > 1) {
        const choice = await prompts.select({
          message: "Which provider should be the default model?",
          options: detectedEnv.map((p) => ({
            value: p.providerID,
            label: p.providerName,
            hint: p.defaultModel,
          })),
        })
        if (prompts.isCancel(choice)) {
          prompts.outro("Setup cancelled")
          return false
        }
        selectedProvider = choice as string
      } else {
        selectedProvider = detectedEnv[0].providerID
      }
      return await useDetectedProviders(detectedEnv, selectedProvider)
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

async function useDetectedProviders(detectedEnv: DetectedProvider[], primaryProviderID: string): Promise<boolean> {
  const primary = detectedEnv.find((p) => p.providerID === primaryProviderID)!
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

  return await saveConfig(spinner, async () => {
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
    prompts.log.info(`Config file: ${ConfigDomain.filepath("models")}`)
    prompts.outro("Done")
  })
}

async function manualProviderSelection(selectedCount = 0): Promise<boolean> {
  const entries = Object.entries(PROVIDER_ENV_MAP).map(([id, info]) => ({ id, ...info }))
  const featured = entries.filter((e) => e.order <= 4).sort((a, b) => a.order - b.order)
  const rest = entries.filter((e) => e.order > 4).sort((a, b) => a.name.localeCompare(b.name))
  const selectOptions = [...featured, ...rest].map((e) => ({
    value: e.id,
    label: featured.includes(e) ? `✦ ${e.name}` : e.name,
    hint: e.defaultModel,
  }))

  const firstValue = entries.sort((a, b) => a.order - b.order)[0].id

  UI.empty()
  prompts.intro(selectedCount > 0 ? "Add Another Provider" : "Select a Provider")

  const providerID = await prompts.select({
    message: "Choose an AI provider:",
    options: selectOptions,
    initialValue: firstValue,
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

  const saved = await saveConfig(spinner, async () => {
    if (apiKey) {
      await Auth.set(providerID as string, { type: "api", key: apiKey })
    }

    if (selectedCount === 0) {
      await Config.updateGlobal({ model: modelString } as Config.Info)
    } else {
      const existing = await Config.globalResolved().catch(() => ({}) as Config.Info)
      if (!existing.model) {
        await Config.updateGlobal({ model: modelString } as Config.Info)
      }
    }

    spinner.stop("✓ Provider configured")
    prompts.log.success(`${providerInfo.name} configured — default model: ${modelString}`)
    prompts.log.info(`Config file: ${ConfigDomain.filepath("models")}`)
  })

  if (!saved) return false

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
}

async function advancedConfig(): Promise<boolean> {
  UI.empty()
  prompts.intro("Advanced Configuration")

  const advancedAction = await prompts.select({
    message: "What would you like to configure?",
    options: [{ value: "full", label: "Full interactive setup", hint: "configure everything step by step" }],
    initialValue: "full",
  })
  if (prompts.isCancel(advancedAction)) {
    prompts.outro("Cancelled")
    return false
  }

  // Full interactive setup: walk through core fields
  const allEntries = Object.entries(PROVIDER_ENV_MAP)
    .map(([id, info]) => ({ id, ...info }))
    .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))

  const primary = await prompts.select({
    message: "Select primary AI provider:",
    options: allEntries.map((e) => ({ value: e.id, label: e.name, hint: e.defaultModel })),
    initialValue: allEntries[0].id,
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

  return await saveConfig(spinner, async () => {
    if (apiKey) {
      await Auth.set(primary as string, { type: "api", key: apiKey })
    }
    await Config.updateGlobal(configData as Config.Info)
    spinner.stop("✓ Configuration saved")
    prompts.log.success("Advanced configuration saved")
    prompts.log.info(`Config file: ${ConfigDomain.filepath("models")}`)
    prompts.outro("Done")
  })
}

export const ConfigWizardCommand = cmd({
  command: "wizard",
  describe: "interactive config wizard — auto-detect and set up providers",
  async handler() {
    await runConfigWizard()
  },
})
