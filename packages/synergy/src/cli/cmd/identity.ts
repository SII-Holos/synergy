import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
import { UI } from "../ui"
import { Config } from "../../config/config"

export const IdentityCommand = cmd({
  command: "identity",
  describe: "configure identity (embedding, evolution, learning)",
  builder: (yargs) =>
    yargs
      .command(IdentityEmbeddingCommand)
      .command(IdentityLearningCommand)
      .command(IdentityShowCommand)
      .demandCommand(),
  async handler() {},
})

export const IdentityShowCommand = cmd({
  command: "show",
  describe: "show current identity configuration",
  async handler() {
    UI.empty()
    prompts.intro("Identity Config")

    const cfg = await Config.get()
    const identity = cfg.identity

    if (!identity) {
      prompts.log.warn("No identity configuration found")
      prompts.outro("Configure with: synergy identity embedding")
      return
    }

    if (identity.embedding) {
      const e = identity.embedding
      prompts.log.info(
        `Embedding\n` +
          `  baseURL: ${e.baseURL ?? "(default: https://api.siliconflow.cn/v1)"}\n` +
          `  model:   ${e.model ?? "(default: Qwen/Qwen3-Embedding-8B)"}\n` +
          `  apiKey:  ${e.apiKey ? "***configured***" : "(not set)"}`,
      )
    } else {
      prompts.log.warn("Embedding: not configured")
    }

    const evo = Config.resolveEvolution(identity.evolution)
    prompts.log.info(
      `Evolution\n` + `  encode:   ${evo.encode}\n` + `  retrieve: ${evo.retrieve}\n` + `  active:   ${evo.active}`,
    )

    const l = evo.learning
    const r = evo.passiveRetrieval
    prompts.log.info(
      `Learning\n` +
        `  alpha:           ${l.alpha}\n` +
        `  qInit:           ${l.qInit}\n` +
        `  dedupIntentThreshold:  ${l.dedupIntentThreshold}\n` +
        `  dedupScriptThreshold: ${l.dedupScriptThreshold}`,
    )
    prompts.log.info(
      `Retrieval\n` +
        `  simThreshold:    ${r.simThreshold}\n` +
        `  topK:            ${r.topK}\n` +
        `  epsilon:         ${r.epsilon}\n` +
        `  wSim:            ${r.wSim}\n` +
        `  wQ:              ${r.wQ}\n` +
        `  explorationConstant: ${r.explorationConstant}`,
    )

    prompts.outro("Done")
  },
})

export const IdentityEmbeddingCommand = cmd({
  command: "embedding",
  describe: "configure embedding model (writes to global config)",
  builder: (yargs) =>
    yargs.option("print", {
      type: "boolean",
      describe: "print config instead of writing to file",
    }),
  async handler(args) {
    UI.empty()
    prompts.intro("Configure Embedding")

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

    const config: Config.Info = {
      identity: {
        embedding: { baseURL, model, apiKey },
      },
    }

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

export const IdentityLearningCommand = cmd({
  command: "learning",
  describe: "configure learning hyperparameters (writes to global config)",
  builder: (yargs) =>
    yargs.option("print", {
      type: "boolean",
      describe: "print config instead of writing to file",
    }),
  async handler(args) {
    UI.empty()
    prompts.intro("Configure Learning Hyperparameters")

    const defaults = Config.LEARNING_DEFAULTS
    const rDefaults = Config.PASSIVE_RETRIEVAL_DEFAULTS

    const alpha = await promptNumber("Q-learning rate (alpha)", defaults.alpha, 0, 1)
    const qInit = await promptNumber("Optimistic Q-value init per dimension", defaults.qInit, -10, 10)
    const dedupIntentThreshold = await promptNumber(
      "Dedup intent similarity threshold",
      defaults.dedupIntentThreshold,
      0,
      1,
    )
    const dedupScriptThreshold = await promptNumber(
      "Dedup script similarity threshold",
      defaults.dedupScriptThreshold,
      0,
      1,
    )

    const simThreshold = await promptNumber("Retrieval similarity threshold", rDefaults.simThreshold, 0, 1)
    const topK = await promptNumber("Number of experiences to retrieve (topK)", rDefaults.topK, 1, 100)
    const epsilon = await promptNumber("Exploration probability (epsilon)", rDefaults.epsilon, 0, 1)
    const wSim = await promptNumber("Similarity weight in hybrid score (wSim)", rDefaults.wSim, 0, 1)
    const wQ = await promptNumber("Q-value weight in hybrid score (wQ)", rDefaults.wQ, 0, 1)
    const explorationConstant = await promptNumber("UCB exploration constant", rDefaults.explorationConstant, 0, 10)

    const learning: Config.Learning = {
      alpha,
      qInit,
      dedupIntentThreshold,
      dedupScriptThreshold,
    }

    const retrieve: Config.PassiveRetrieval = {
      simThreshold,
      topK,
      epsilon,
      wSim,
      wQ,
      explorationConstant,
    }

    const config: Config.Info = {
      identity: {
        evolution: {
          passive: { learning, retrieve },
        },
      },
    }

    if (args.print) {
      prompts.log.success("Learning configured!")
      prompts.log.info("Add this to your config file:")
      prompts.log.message(JSON.stringify(config, null, 2))
    } else {
      await Config.updateGlobal(config)
      prompts.log.success("Learning configuration saved to the active global Config Set")
      prompts.log.info(`Config file: ${await Config.globalPath()}`)
    }

    prompts.outro("Done")
  },
})

async function promptNumber(message: string, defaultValue: number, min: number, max: number): Promise<number> {
  const result = await prompts.text({
    message: `${message}`,
    placeholder: String(defaultValue),
    initialValue: String(defaultValue),
    validate: (x) => {
      const n = Number(x)
      if (isNaN(n)) return "Must be a number"
      if (n < min || n > max) return `Must be between ${min} and ${max}`
      return undefined
    },
  })
  if (prompts.isCancel(result)) throw new UI.CancelledError()
  return Number(result)
}
