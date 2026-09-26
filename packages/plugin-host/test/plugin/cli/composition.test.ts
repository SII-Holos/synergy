import { expect, test } from "bun:test"
import yargs from "yargs"
import { createPluginCommand } from "../../../src/plugin/cli/plugin"

test("plugin host exposes authoring commands only when the host supplies the Kit", async () => {
  const help = (commands: Parameters<typeof createPluginCommand>[0]) =>
    new Promise<string>((resolve, reject) => {
      yargs()
        .scriptName("synergy")
        .command(createPluginCommand(commands))
        .help()
        .exitProcess(false)
        .parse("plugin --help", (error: Error | null, _argv: unknown, output: string) =>
          error ? reject(error) : resolve(output),
        )
    })
  expect(await help([])).not.toContain("plugin build")
  expect(await help([{ command: "build", describe: "build a plugin", handler() {} }])).toContain("plugin build")
})
