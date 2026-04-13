import { cmd } from "./cmd"
import { UI } from "../ui"
import { ConfigSetup } from "../../config/setup"
import { Config } from "../../config/config"
import { SetupService } from "../../setup/service"
import { Scope } from "../../scope"
import { Instance } from "../../scope/instance"
import { InstanceBootstrap } from "../../project/bootstrap"
import { FormatError, FormatUnknownError } from "../error"
import { Log } from "../../util/log"
import open from "open"
import path from "path"
import fs from "fs"

const CONFIG_UI_PORT_START = 4500

function resolveConfigAppDist() {
  const fromExec = path.resolve(path.dirname(fs.realpathSync(process.execPath)), "../config-ui")
  if (fs.existsSync(fromExec)) return fromExec
  return path.resolve(import.meta.dirname, "../../../../config-ui/dist")
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  })
}

function formatStartupError(stage: string, error: unknown) {
  const logPath = Log.file()
  const debugLines = [
    `Debug: rerun with \`synergy config ui --print-logs\``,
    ...(logPath ? [`Log file: ${logPath}`] : []),
  ]
  const formatted = FormatError(error)
  if (formatted) {
    return [`Config UI failed to start during ${stage}.`, formatted, ...debugLines].join("\n")
  }

  return [`Config UI failed to start during ${stage}.`, FormatUnknownError(error), ...debugLines].join("\n")
}

async function handleScopedAPI(req: Request, url: URL): Promise<Response> {
  try {
    const pathname = url.pathname

    if (pathname === "/api/config" && req.method === "GET") {
      const config = await SetupService.readCurrentConfig()
      return json({ config })
    }

    if (pathname === "/api/providers" && req.method === "GET") {
      const providers = await ConfigSetup.getAvailableProviders()
      return json({ providers })
    }

    if (pathname === "/api/providers/connected" && (req.method === "GET" || req.method === "POST")) {
      const body =
        req.method === "POST"
          ? ((await req.json()) as {
              stagedAuth?: Record<string, ConfigSetup.StagedAuthChange>
              stagedProviders?: Record<string, Config.Provider>
            })
          : {}
      const connected = await ConfigSetup.getConnectedProviders(body.stagedAuth, body.stagedProviders)
      return json({ connected })
    }

    if (pathname === "/api/auth/verify" && req.method === "POST") {
      const body = (await req.json()) as { providerID: string; key: string }
      if (!body.providerID || !body.key) {
        return json({ error: "providerID and key are required" }, 400)
      }
      const result = await ConfigSetup.verifyAuth(body.providerID, body.key)
      return json(result)
    }

    if (pathname === "/api/auth/save" && req.method === "POST") {
      const body = (await req.json()) as { providerID: string; key: string }
      if (!body.providerID || !body.key) {
        return json({ error: "providerID and key are required" }, 400)
      }
      await ConfigSetup.saveAuth(body.providerID, body.key)
      return json({ ok: true })
    }

    if (pathname === "/api/auth/remove" && req.method === "POST") {
      const body = (await req.json()) as { providerID: string }
      if (!body.providerID) {
        return json({ error: "providerID is required" }, 400)
      }
      await ConfigSetup.removeAuth(body.providerID)
      return json({ ok: true })
    }

    if (pathname === "/api/config/validate" && req.method === "POST") {
      const body = (await req.json()) as { config: unknown }
      const result = await SetupService.validateImport(body.config)
      return json(result)
    }

    if (pathname === "/api/config/probe" && req.method === "POST") {
      const body = (await req.json()) as { config: unknown }
      const validation = await SetupService.probeImport(body.config)
      return json(validation)
    }

    if (pathname === "/api/config/import" && req.method === "POST") {
      const body = (await req.json()) as { config: unknown }
      const filepath = await SetupService.importConfig(body.config)
      return json({ ok: true, filepath })
    }

    if (pathname === "/api/models/discover" && req.method === "POST") {
      const body = (await req.json()) as { baseURL: string; apiKey: string; type?: "embedding" | "rerank" }
      if (!body.baseURL || !body.apiKey) {
        return json({ error: "baseURL and apiKey are required" }, 400)
      }
      const models = await ConfigSetup.discoverModels(body)
      return json({ models })
    }

    if (pathname === "/api/providers/custom/preview" && req.method === "POST") {
      const body = (await req.json()) as { draft: ConfigSetup.CustomProviderDraft }
      const preview = await ConfigSetup.previewCustomProvider(body.draft)
      return json(preview)
    }

    if (pathname === "/api/providers/custom/verify" && req.method === "POST") {
      const body = (await req.json()) as { draft: ConfigSetup.CustomProviderDraft }
      const result = await ConfigSetup.verifyCustomProvider(body.draft)
      return json(result)
    }

    if (pathname === "/api/setup/validate-core" && req.method === "POST") {
      const body = (await req.json()) as { config: ConfigSetup.SetupDraft }
      const validation = await SetupService.validateCore(body.config ?? {})
      return json(validation)
    }

    if (pathname === "/api/setup/finalize" && req.method === "POST") {
      const body = (await req.json()) as { config: ConfigSetup.SetupDraft }
      const result = await SetupService.finalizeSetup(body.config ?? {})
      return json({ ok: true, filepath: result.filepath, validation: result.validation })
    }

    return json({ error: "Not found" }, 404)
  } catch (error) {
    const message = error instanceof Error ? error.message : "Internal server error"
    return json({ error: message }, 500)
  }
}

async function handleAPI(req: Request, url: URL, scope: Scope): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    })
  }

  return Instance.provide({
    scope,
    init: InstanceBootstrap,
    fn: () => handleScopedAPI(req, url),
  })
}

export const ConfigUICommand = cmd({
  command: "ui",
  describe: "open configuration web UI in browser",
  builder: (yargs) =>
    yargs.option("dev", {
      type: "boolean",
      describe: "start with Vite dev server (HMR enabled)",
      default: false,
    }),
  async handler(args) {
    let stage = "initializing"
    try {
      UI.empty()
      UI.println(UI.logo("  "))
      UI.empty()

      stage = "resolving scope"
      const scope = (await Scope.fromDirectory(process.cwd())).scope

      stage = "bootstrapping runtime"
      await Instance.provide({
        scope,
        init: InstanceBootstrap,
        fn: () => ConfigSetup.init(),
      })

      if (args.dev) {
        stage = "starting development Config UI"
        const configAppDir = path.resolve(import.meta.dirname, "../../../../config-ui")
        const vitePort = CONFIG_UI_PORT_START
        const apiPort = CONFIG_UI_PORT_START + 1

        const { promise: donePromise, resolve: doneResolve } = Promise.withResolvers<void>()

        const apiServer = Bun.serve({
          port: apiPort,
          async fetch(req) {
            const url = new URL(req.url)
            const result = await handleAPI(req, url, scope)
            if (url.pathname === "/api/setup/finalize" && result.ok) {
              setTimeout(() => doneResolve(), 500)
            }
            return result
          },
        })

        UI.println(
          UI.Style.TEXT_INFO_BOLD + "  API server:        ",
          UI.Style.TEXT_NORMAL,
          `http://localhost:${apiPort}`,
        )
        UI.println(
          UI.Style.TEXT_INFO_BOLD + "  Web UI (dev):      ",
          UI.Style.TEXT_NORMAL,
          `http://localhost:${vitePort}`,
        )
        UI.empty()

        Bun.spawn([process.execPath, "run", "dev"], {
          cwd: configAppDir,
          env: { ...process.env, VITE_API_PORT: apiPort.toString() },
          stdio: ["inherit", "inherit", "inherit"],
        })

        const start = Date.now()
        while (Date.now() - start < 10000) {
          const ready = await fetch(`http://localhost:${vitePort}`)
            .then(() => true)
            .catch(() => false)
          if (ready) break
          await Bun.sleep(200)
        }

        try {
          open(`http://localhost:${vitePort}`).catch(() => {})
        } catch {}
        await donePromise
        apiServer.stop()
        return
      }

      stage = "starting bundled Config UI"
      const distDir = resolveConfigAppDist()
      const indexFile = Bun.file(path.join(distDir, "index.html"))
      if (!(await indexFile.exists().catch(() => false))) {
        throw new Error("Config UI not built. Run: bun run --cwd packages/config-ui build")
      }

      const indexHtml = await indexFile.text()

      const { promise: donePromise, resolve: doneResolve } = Promise.withResolvers<void>()

      const server = Bun.serve({
        port: CONFIG_UI_PORT_START,
        async fetch(req) {
          const url = new URL(req.url)

          if (url.pathname.startsWith("/api/")) {
            const result = await handleAPI(req, url, scope)
            if (url.pathname === "/api/setup/finalize" && result.status === 200) {
              setTimeout(() => doneResolve(), 500)
            }
            return result
          }

          const reqPath = decodeURI(url.pathname)
          const filePath = path.join(distDir, reqPath)
          if (filePath.startsWith(distDir)) {
            const file = Bun.file(filePath)
            if (await file.exists().catch(() => false)) {
              const stat = await file.stat()
              if (!stat.isDirectory()) {
                const headers: Record<string, string> = {
                  "Content-Type": file.type || "application/octet-stream",
                }
                if (filePath.includes("/assets/")) {
                  headers["Cache-Control"] = "public, immutable, max-age=31536000"
                }
                return new Response(file.stream(), { headers })
              }
            }
          }

          return new Response(indexHtml, {
            headers: { "Content-Type": "text/html; charset=utf-8" },
          })
        },
      })

      const host = server.hostname === "0.0.0.0" || server.hostname === "::" ? "localhost" : server.hostname
      const uiUrl = `http://${host}:${server.port}`
      UI.println(UI.Style.TEXT_INFO_BOLD + "  Config UI:         ", UI.Style.TEXT_NORMAL, uiUrl)
      UI.empty()

      try {
        open(uiUrl).catch(() => {})
      } catch {}

      await donePromise
      UI.empty()
      UI.println(
        UI.Style.TEXT_SUCCESS +
          "  Configuration saved. Run `synergy models` to verify your setup, then `synergy start` or `synergy server` to start the server.",
      )
      UI.empty()
      server.stop()
    } catch (error) {
      UI.error(formatStartupError(stage, error))
      throw error
    }
  },
})
