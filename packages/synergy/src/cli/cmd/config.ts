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
      .command(ConfigRerankCommand),
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
