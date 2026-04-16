import { UI } from "../ui"
import { cmd } from "./cmd"
import open from "open"
import path from "path"
import { Server } from "../../server/server"
import { Access } from "../../access"
import { isServerReachable } from "../network"

const WEB_DEV_PORT = 3000

function resolveAppDir() {
  return path.resolve(import.meta.dirname, "../../../../app")
}

async function waitForPort(port: number, timeout = 10000): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    const ready = await fetch(`http://localhost:${port}`)
      .then(() => true)
      .catch(() => false)
    if (ready) return true
    await Bun.sleep(200)
  }
  return false
}

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
    yargs
      .option("attach", {
        type: "string",
        describe: "URL of a running synergy server",
        default: Server.DEFAULT_URL,
      })
      .option("dev", {
        type: "boolean",
        describe: "start with Vite dev server (HMR enabled)",
        default: false,
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

    if (args.dev) {
      const appDir = resolveAppDir()
      const vitePort = WEB_DEV_PORT
      const viteUrl = `http://localhost:${vitePort}`

      UI.println(UI.Style.TEXT_INFO_BOLD + "  Web UI (dev):      ", UI.Style.TEXT_NORMAL, viteUrl)
      UI.empty()

      Bun.spawn([process.execPath, "run", "dev"], {
        cwd: appDir,
        env: { ...process.env, ...Access.frontendEnv(serverUrl) },
        stdio: ["inherit", "inherit", "inherit"],
      })

      await waitForPort(vitePort)
      open(viteUrl).catch(() => {})
    } else {
      if (!(await hasRuntimeWebUi(access.attachUrl))) {
        UI.error(`The running server at ${access.attachUrl} is reachable, but it is not serving the web UI.`)
        UI.println(
          UI.Style.TEXT_DIM + "  If you're developing the web app, use:",
          UI.Style.TEXT_NORMAL,
          "  synergy web --dev",
        )
        UI.println(
          UI.Style.TEXT_DIM + "  If you need the production app bundle, build it with:",
          UI.Style.TEXT_NORMAL,
          "  bun run --cwd packages/app build",
        )
        UI.empty()
        process.exit(1)
      }

      UI.println(UI.Style.TEXT_INFO_BOLD + "  Web UI:            ", UI.Style.TEXT_NORMAL, access.attachUrl)
      UI.empty()
      open(access.attachUrl).catch(() => {})
      return
    }

    await new Promise(() => {})
  },
})
