import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
import { UI } from "../ui"
import { Config } from "../../config/config"
import { ConfigDomain } from "../../config/domain"

export const EngramCommand = cmd({
  command: "engram",
  describe: "manage engram memory and learning",
  builder: (yargs) =>
    yargs.command(EngramShowCommand).command(EngramLearningCommand).command(EngramMemoryCommand).demandCommand(),
  async handler() {},
})

export const EngramShowCommand = cmd({
  command: "show",
  describe: "show current engram configuration",
  async handler() {
    UI.empty()
    prompts.intro("Engram Config")

    const cfg = await Config.get()
    const engram = (cfg as any).engram

    if (!engram) {
      prompts.log.warn("No engram configuration found")
      prompts.outro("Configure with: synergy engram memory or synergy engram learning")
      return
    }

    // Memory
    const mem = engram.memory
    if (mem) {
      prompts.log.info(
        `Memory\n` +
          `  enabled:         ${mem.enabled ?? "not set"}\n` +
          `  simThreshold:    ${mem.simThreshold ?? "(default)"}\n` +
          `  topK:            ${mem.topK ?? "(default)"}\n` +
          `  dedupThreshold:  ${mem.dedupThreshold ?? "(default)"}`,
      )
    } else {
      prompts.log.warn("Memory: not configured")
    }

    // Experience
    const exp = engram.experience
    if (exp) {
      prompts.log.info(
        `Experience\n` + `  encode:   ${exp.encode ?? "not set"}\n` + `  retrieve: ${exp.retrieve ?? "not set"}`,
      )
    } else {
      prompts.log.warn("Experience: not configured")
    }

    // Autonomy
    prompts.log.info(`Autonomy: ${engram.autonomy ?? "not set (default: true)"}`)

    prompts.outro("Done")
  },
})

export const EngramLearningCommand = cmd({
  command: "learning",
  describe: "configure experience learning parameters (writes to global config)",
  builder: (yargs) =>
    yargs.option("print", {
      type: "boolean",
      describe: "print config instead of writing to file",
    }),
  async handler(args) {
    UI.empty()
    prompts.intro("Configure Learning Parameters")

    const defaults = Config.LEARNING_DEFAULTS

    const alpha = await promptNumber("Q-learning rate (alpha)", defaults.alpha, 0, 1)
    const qInit = await promptNumber("Optimistic Q-value init per dimension", defaults.qInit, -10, 10)
    const rewardDelay = await promptNumber("Number of turns before evaluating reward", defaults.rewardDelay, 0, 20)

    // Reward weights
    const rw = defaults.rewardWeights
    prompts.log.info("Reward Weights:")
    const outcome = await promptNumber("  outcome", rw.outcome, 0, 1)
    const intent = await promptNumber("  intent", rw.intent, 0, 1)
    const execution = await promptNumber("  execution", rw.execution, 0, 1)
    const orchestration = await promptNumber("  orchestration", rw.orchestration, 0, 1)
    const expression = await promptNumber("  expression", rw.expression, 0, 1)

    const config = {
      engram: {
        experience: {
          learning: {
            alpha,
            qInit,
            rewardDelay,
            rewardWeights: { outcome, intent, execution, orchestration, expression },
          },
        },
      },
    } as any as Config.Info

    if (args.print) {
      prompts.log.success("Learning configured!")
      prompts.log.info("Add this to your config file:")
      prompts.log.message(JSON.stringify(config, null, 2))
    } else {
      await Config.updateGlobal(config)
      prompts.log.success("Learning configuration saved")
      prompts.log.info(`Config file: ${ConfigDomain.filepath("engram")}`)
    }

    prompts.outro("Done")
  },
})

export const EngramMemoryCommand = cmd({
  command: "memory",
  describe: "configure memory parameters (writes to global config)",
  builder: (yargs) =>
    yargs.option("print", {
      type: "boolean",
      describe: "print config instead of writing to file",
    }),
  async handler(args) {
    UI.empty()
    prompts.intro("Configure Memory Parameters")

    const enabled = await prompts.confirm({
      message: "Enable memory?",
      initialValue: true,
    })
    if (prompts.isCancel(enabled)) throw new UI.CancelledError()

    const simThreshold = await promptNumber("Retrieval similarity threshold", 0.7, 0, 1)
    const topK = await promptNumber("Number of memories to retrieve (topK)", 8, 1, 100)
    const dedupThreshold = await promptNumber("Memory dedup similarity threshold", 0.75, 0, 1)

    const config = {
      engram: {
        memory: {
          enabled,
          simThreshold,
          topK,
          dedupThreshold,
        },
      },
    } as any as Config.Info

    if (args.print) {
      prompts.log.success("Memory configured!")
      prompts.log.info("Add this to your config file:")
      prompts.log.message(JSON.stringify(config, null, 2))
    } else {
      await Config.updateGlobal(config)
      prompts.log.success("Memory configuration saved")
      prompts.log.info(`Config file: ${ConfigDomain.filepath("engram")}`)
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
