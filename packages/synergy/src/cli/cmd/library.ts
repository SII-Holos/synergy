import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
import { UI } from "../ui"
import { Config } from "../../config/config"
import { ConfigDomain } from "../../config/domain"
import { Global } from "../../global"
import { detect } from "../../library/experience-detect"

export const LibraryCommand = cmd({
  command: "library",
  describe: "manage library memory and learning",
  builder: (yargs) =>
    yargs
      .command(LibraryShowCommand)
      .command(LibraryLearningCommand)
      .command(LibraryMemoryCommand)
      .command(LibraryReencodeCommand)
      .demandCommand(),
  async handler() {},
})

export const LibraryShowCommand = cmd({
  command: "show",
  describe: "show current library configuration",
  async handler() {
    UI.empty()
    prompts.intro("Library Config")

    const cfg = await Config.globalResolved()
    const library = cfg.library

    if (!library) {
      prompts.log.warn("No library configuration found")
      prompts.outro("Configure with: synergy library memory or synergy library learning")
      return
    }

    // Memory
    const mem = library.memory
    if (mem) {
      prompts.log.info(
        `Memory\n` +
          `  enabled:         ${mem.enabled ?? "not set"}\n` +
          `  simThreshold:    ${mem.retrieval?.simThreshold ?? "(default)"}\n` +
          `  topK:            ${mem.retrieval?.topK ?? "(default)"}\n` +
          `  dedupThreshold:  ${mem.dedup?.threshold ?? "(default)"}`,
      )
    } else {
      prompts.log.warn("Memory: not configured")
    }

    // Experience
    const exp = library.experience
    if (exp) {
      prompts.log.info(
        `Experience\n` + `  encode:   ${exp.encode ?? "not set"}\n` + `  retrieve: ${exp.retrieve ?? "not set"}`,
      )
    } else {
      prompts.log.warn("Experience: not configured")
    }

    // Autonomy
    prompts.log.info(`Autonomy: ${library.autonomy ?? "not set (default: true)"}`)

    prompts.outro("Done")
  },
})

export const LibraryLearningCommand = cmd({
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
      library: {
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
      prompts.log.info(`Config file: ${ConfigDomain.filepath("library")}`)
    }

    prompts.outro("Done")
  },
})

export const LibraryMemoryCommand = cmd({
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
      library: {
        memory: {
          enabled,
          retrieval: { simThreshold, topK },
          dedup: { threshold: dedupThreshold },
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
      prompts.log.info(`Config file: ${ConfigDomain.filepath("library")}`)
    }

    prompts.outro("Done")
  },
})

export const LibraryReencodeCommand = cmd({
  command: "reencode",
  describe: "detect experience candidates with low-quality intent or script",
  builder: (yargs) =>
    yargs
      .option("db", {
        type: "string",
        describe: "path to library.db (defaults to global data dir)",
      })
      .option("limit", {
        type: "number",
        describe: "max candidates to show",
        default: 10,
      })
      .option("intent", {
        type: "boolean",
        describe: "show intent candidates",
        default: true,
      })
      .option("script", {
        type: "boolean",
        describe: "show script candidates",
        default: true,
      }),
  async handler(args) {
    UI.empty()
    prompts.intro("Experience Re-encode Detection")

    const dbPath = args.db ?? Global.Path.libraryDB

    prompts.log.info(`Database: ${dbPath}`)

    const result = detect(dbPath)
    const limit = (args.limit as number) ?? 10
    const showIntent = args.intent !== false
    const showScript = args.script !== false

    if (showIntent) {
      // Group by reason
      const groups = new Map<string, number>()
      for (const c of result.intent) {
        groups.set(c.reason, (groups.get(c.reason) ?? 0) + 1)
      }

      prompts.log.info(`Intent candidates: ${result.intent.length} total`)
      for (const [reason, count] of groups) {
        prompts.log.message(`  ${reason}: ${count}`)
      }

      if (result.intent.length > 0) {
        const sample = result.intent.slice(0, limit)
        prompts.log.info(`Samples (${sample.length} of ${result.intent.length}):`)
        for (const c of sample) {
          const preview =
            c.intent && c.intent.length > 80 ? c.intent.slice(0, 80).replace(/\n/g, " ") + "…" : (c.intent ?? "")
          prompts.log.message(`  ${c.reason} | ${c.id}`)
          prompts.log.message(`    detail: ${c.detail}`)
          if (preview) prompts.log.message(`    intent: ${preview}`)
        }
      }
    }

    if (showScript) {
      const groups = new Map<string, number>()
      for (const c of result.script) {
        groups.set(c.reason, (groups.get(c.reason) ?? 0) + 1)
      }

      prompts.log.info(`Script candidates: ${result.script.length} total`)
      for (const [reason, count] of groups) {
        prompts.log.message(`  ${reason}: ${count}`)
      }

      if (result.script.length > 0) {
        const sample = result.script.slice(0, limit)
        prompts.log.info(`Samples (${sample.length} of ${result.script.length}):`)
        for (const c of sample) {
          prompts.log.message(`  ${c.reason} | ${c.id}`)
          prompts.log.message(`    detail: ${c.detail}`)
        }
      }
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
