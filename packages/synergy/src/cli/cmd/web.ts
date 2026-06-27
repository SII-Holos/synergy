import { UI } from "../ui"
import { cmd } from "./cmd"
import open from "open"
import { Server } from "../../server/server"
import { Access } from "../../access"
import { isServerReachable } from "../network"

async function hasRuntimeWebUi(url: string) {
  try {
    const response = await fetch(url, { redirect: "follow" })
    const contentType = response.headers.get("content-type") ?? ""
    return response.ok && contentType.includes("text/html")
  } catch {
    return false
  }
}

export const WebCommand = cmd({
  command: "web",
  builder: (yargs) =>
    yargs.option("attach", {
      type: "string",
      describe: "URL of a running synergy server",
      default: Server.DEFAULT_URL,
    }),
  describe: "open web interface (connects to running server)",
  handler: async (args) => {
    const serverUrl = args.attach

    if (!(await isServerReachable(serverUrl))) {
      UI.error(`No running server found at ${serverUrl}`)
      UI.println(UI.Style.TEXT_DIM + "  Start a background server:", UI.Style.TEXT_NORMAL, "  synergy start")
      UI.println(
        UI.Style.TEXT_DIM + "  Or run a foreground server for debugging:",
        UI.Style.TEXT_NORMAL,
        "  synergy server",
      )
      UI.println(
        UI.Style.TEXT_DIM + "  If your server is on a different port:",
        UI.Style.TEXT_NORMAL,
        "  synergy web --attach http://localhost:<port>",
      )
      UI.empty()
      process.exit(1)
    }

    const access = Access.fromServerUrl(serverUrl)

    UI.empty()
    UI.println(UI.logo("  "))
    UI.empty()
    UI.println(UI.Style.TEXT_INFO_BOLD + "  API server:        ", UI.Style.TEXT_NORMAL, serverUrl)

    if (!(await hasRuntimeWebUi(access.attachUrl))) {
      UI.error(`The running server at ${access.attachUrl} is reachable, but it is not serving the web UI.`)
      UI.println(
        UI.Style.TEXT_DIM + "  In a source checkout, start the app dev server with:",
        UI.Style.TEXT_NORMAL,
        "  bun dev app --open",
      )
      UI.println(
        UI.Style.TEXT_DIM + "  If you need the production app bundle, build it with:",
        UI.Style.TEXT_NORMAL,
        "  bun dev build app",
      )
      UI.empty()
      process.exit(1)
    }

    UI.println(UI.Style.TEXT_INFO_BOLD + "  Web UI:            ", UI.Style.TEXT_NORMAL, access.attachUrl)
    UI.empty()
    open(access.attachUrl).catch(() => {})
  },
})
