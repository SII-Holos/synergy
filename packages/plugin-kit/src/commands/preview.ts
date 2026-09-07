import path from "node:path"
import type { Argv } from "yargs"
import { cmd } from "../cmd.js"
import { UI } from "../ui.js"
import { startPluginPreview } from "../lib/preview.js"
import { buildPluginProject } from "./build.js"
import { watchPluginProject } from "./dev.js"

export const PluginPreviewCommand = cmd({
  command: "preview [path]",
  describe: "build and watch a plugin in an isolated real Synergy host",
  builder: (yargs: Argv) =>
    yargs
      .positional("path", { type: "string", describe: "plugin directory (defaults to cwd)" })
      .option("host-command", {
        type: "array",
        string: true,
        describe: "host executable and arguments (defaults to installed synergy)",
      }),
  async handler(args) {
    const directory = path.resolve((args.path as string) ?? process.cwd())
    if (!(await buildPluginProject(directory))) {
      process.exitCode = 1
      return
    }
    const controller = new AbortController()
    const stop = () => controller.abort()
    process.once("SIGINT", stop)
    process.once("SIGTERM", stop)
    try {
      const preview = await startPluginPreview({
        artifacts: [path.join(directory, "dist")],
        command: args["host-command"] as string[] | undefined,
        signal: controller.signal,
      })
      const watcher = watchPluginProject(directory, {
        serverUrl: preview.url,
        isolatedHome: preview.home,
        initialBuild: true,
      })
      UI.println(`Preview: ${preview.url}`)
      UI.println(
        "Approve the plugin in Plugins, then select its Shell or Skin in Settings → General. Restart preview after changing capabilities to review the new grants.",
      )
      try {
        await preview.exited
      } finally {
        await watcher.close()
        await preview.close()
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        UI.error(error instanceof Error ? error.message : String(error))
        process.exitCode = 1
      }
    } finally {
      process.removeListener("SIGINT", stop)
      process.removeListener("SIGTERM", stop)
    }
  },
})
