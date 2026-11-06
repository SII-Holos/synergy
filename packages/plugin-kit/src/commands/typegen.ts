import path from "node:path"
import type { Argv } from "yargs"
import { cmd } from "../cmd.js"
import { generatePluginDataTypes } from "../lib/typegen.js"
import { UI } from "../ui.js"

export const PluginTypegenCommand = cmd({
  command: "typegen [path]",
  describe: "generate UI operation and event types from plugin schemas",
  builder: (yargs: Argv) =>
    yargs.positional("path", { type: "string", describe: "plugin directory (defaults to cwd)" }),
  async handler(args) {
    UI.println(await generatePluginDataTypes(path.resolve((args.path as string) ?? process.cwd())))
  },
})
