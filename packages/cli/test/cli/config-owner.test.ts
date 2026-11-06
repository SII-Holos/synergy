import { expect, spyOn, test } from "bun:test"
import * as prompts from "@clack/prompts"
import yargs from "yargs"
import { ConfigCommand, ConfigEmbeddingCommand, ConfigRerankCommand, runConfigWizard } from "../../src/cli/cmd/config"
import { testRuntime } from "../support/runtime"

test("Core config help omits unregistered Library commands and rejects their invocation", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    const embedding = spyOn(ConfigEmbeddingCommand, "handler").mockImplementation(async () => {})
    const rerank = spyOn(ConfigRerankCommand, "handler").mockImplementation(async () => {})
    try {
      const parse = async (args: string[]) => {
        let output = ""
        let failure: Error | undefined
        await yargs([])
          .scriptName("synergy")
          .exitProcess(false)
          .command(ConfigCommand)
          .strict()
          .help()
          .parseAsync(args, (error: Error | undefined, _argv: unknown, result: string) => {
            failure = error
            output = result
          })
        return { output, failure }
      }
      const help = await parse(["config", "--help"])
      expect(help.failure).toBeUndefined()
      expect(help.output).toContain("config wizard")
      expect(help.output).not.toContain("embedding")
      expect(help.output).not.toContain("rerank")
      for (const command of ["embedding", "rerank"]) {
        const result = await parse(["config", command])
        expect(result.failure?.message).toMatch(new RegExp(`Unknown argument: ${command}`))
      }
      expect(embedding).not.toHaveBeenCalled()
      expect(rerank).not.toHaveBeenCalled()
    } finally {
      embedding.mockRestore()
      rerank.mockRestore()
    }
  })
})

test("Core config wizard does not advertise a local embedding model", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    const before = process.env.OPENAI_API_KEY
    process.env.OPENAI_API_KEY = "setup-owner-fixture"
    const messages: string[] = []
    const info = spyOn(prompts.log, "info").mockImplementation((message) => {
      messages.push(message)
    })
    const select = spyOn(prompts, "select").mockResolvedValue("use-detected")
    const confirm = spyOn(prompts, "confirm").mockResolvedValue(false)
    try {
      expect(await runConfigWizard()).toBe(false)
      expect(messages.join("\n")).toContain("Default model:")
      expect(messages.join("\n")).not.toContain("Embedding:")
      expect(messages.join("\n")).not.toContain("look_at")
    } finally {
      if (before === undefined) delete process.env.OPENAI_API_KEY
      else process.env.OPENAI_API_KEY = before
      info.mockRestore()
      select.mockRestore()
      confirm.mockRestore()
    }
  })
})
