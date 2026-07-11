import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  BROWSER_PROTOCOL_VERSION,
  browserOwnerKey,
  BrowserHostMessageSchema,
  type BrowserBackendCommand,
  type BrowserBackendResult,
  type BrowserHostMessage,
} from "@ericsanchezok/synergy-browser"

const runtimeTest = process.env.SYNERGY_DESKTOP_RUNTIME_TEST === "1" ? test : test.skip
const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  )
})

describe("Electron Browser Host broker contract", () => {
  runtimeTest(
    "preserves native presentation origin across viewport resize and recreates an owner after close",
    async () => {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-browser-native-smoke-"))
      temporaryDirectories.push(directory)
      const build = await Bun.build({
        entrypoints: [path.resolve(import.meta.dir, "fixture/browser-native-page-pool.ts")],
        outdir: directory,
        target: "node",
        external: ["electron"],
      })
      if (!build.success) throw new AggregateError(build.logs, "Native Browser smoke fixture did not build.")
      const electron =
        process.env.SYNERGY_DESKTOP_ELECTRON_BIN ?? path.resolve(import.meta.dir, "../node_modules/.bin/electron")
      const child = Bun.spawn(
        [
          electron,
          ...(process.platform === "linux" ? ["--no-sandbox"] : []),
          path.join(directory, "browser-native-page-pool.js"),
        ],
        { cwd: path.resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" },
      )
      const exitCode = await withTimeout(child.exited, 30_000, "Native Browser page pool smoke")
      if (exitCode !== 0) {
        const stdout = await new Response(child.stdout).text().catch(() => "")
        const stderr = await new Response(child.stderr).text().catch(() => "")
        throw new Error(`Native Browser page pool exited with ${exitCode}.\n${stdout}\n${stderr}`)
      }
    },
    45_000,
  )

  runtimeTest(
    "executes protocol v2 through the same CDP controller without a control fallback",
    async () => {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-browser-host-smoke-"))
      temporaryDirectories.push(directory)
      const token = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "")
      const ready = deferred<void>()
      let brokerSocket: ServerWebSocket<{ role: "broker" | "signal" }> | null = null
      const pending = new Map<string, { resolve(value: BrowserBackendResult): void; reject(error: Error): void }>()
      const signalingURLs: URL[] = []

      const server = Bun.serve<{ role: "broker" | "signal" }>({
        port: 0,
        fetch(request, server) {
          const requestURL = new URL(request.url)
          const role = requestURL.pathname.endsWith("/browser/host/broker") ? "broker" : "signal"
          if (role === "signal") signalingURLs.push(requestURL)
          return server.upgrade(request, { data: { role } })
            ? undefined
            : new Response("WebSocket upgrade required", { status: 400 })
        },
        websocket: {
          open() {},
          message(socket, raw) {
            if (socket.data.role === "signal") return
            let message: BrowserHostMessage
            try {
              message = BrowserHostMessageSchema.parse(JSON.parse(String(raw)))
            } catch (error) {
              ready.reject(error instanceof Error ? error : new Error(String(error)))
              return
            }
            if (message.type === "host.register") {
              if (message.token !== token) {
                ready.reject(new Error("Browser Host registration token mismatch"))
                return
              }
              brokerSocket = socket
              socket.send(
                JSON.stringify({
                  type: "host.registered",
                  protocolVersion: BROWSER_PROTOCOL_VERSION,
                  hostId: message.hostId,
                } satisfies BrowserHostMessage),
              )
              ready.resolve()
              return
            }
            if (message.type !== "page.result") return
            const request = pending.get(message.requestId)
            if (!request) return
            pending.delete(message.requestId)
            if (message.error) request.reject(Object.assign(new Error(message.error.message), message.error))
            else request.resolve(message.result ?? { type: "void" })
          },
          close(socket, code, reason) {
            if (socket.data.role !== "broker") return
            const error = new Error(`Browser Host broker closed (${code}): ${reason}`)
            ready.reject(error)
            for (const request of pending.values()) request.reject(error)
            pending.clear()
          },
        },
      })

      const serverUrl = `http://127.0.0.1:${server.port}`
      const electron =
        process.env.SYNERGY_DESKTOP_ELECTRON_BIN ?? path.resolve(import.meta.dir, "../node_modules/.bin/electron")
      const child = Bun.spawn(
        [electron, ...(process.platform === "linux" ? ["--no-sandbox"] : []), "dist/browser-host-main.js"],
        {
          cwd: path.resolve(import.meta.dir, ".."),
          stdout: "pipe",
          stderr: "pipe",
          env: {
            ...process.env,
            SYNERGY_BROWSER_HOST_SERVER_URL: serverUrl,
            SYNERGY_BROWSER_HOST_REGISTRATION_SECRET: token,
          },
        },
      )

      try {
        await withTimeout(ready.promise, 15_000, "Browser Host registration")
        await request({
          type: "page.create",
          protocolVersion: BROWSER_PROTOCOL_VERSION,
          requestId: crypto.randomUUID(),
          ownerKey: browserOwnerKey({ mode: "session", scopeID: "scope", sessionID: "desktop-smoke" }),
          owner: { mode: "session", scopeID: "scope", sessionID: "desktop-smoke", directory },
          routeDirectory: "home",
          presentation: "webrtc",
          page: {
            id: "electron-contract-page",
            url: "about:blank",
            title: "",
            isLoading: false,
            lastActiveAt: null,
          },
          networkProxy: { server: serverUrl, username: "proxy-user", password: "proxy-password" },
          downloadDir: directory,
          signalingTicket: "host-signaling-ticket",
        })

        await command({
          type: "evaluate",
          mode: "trusted",
          expression: `document.body.innerHTML = '<input aria-label="Name" value="before"><button>Continue with Holos</button>'; document.querySelector('button').onclick = () => document.body.dataset.clicked = 'yes'`,
        })
        await command({
          type: "action",
          action: { type: "click", target: { kind: "role", role: "button", name: "Continue with Holos" } },
        })
        await command({
          type: "action",
          action: { type: "fill", target: { kind: "label", text: "Name" }, value: "Electron" },
        })
        expect(
          await command({
            type: "evaluate",
            mode: "readonly",
            expression: `({ clicked: document.body.dataset.clicked, value: document.querySelector('input').value })`,
          }),
        ).toMatchObject({ type: "evaluation", value: { clicked: "yes", value: "Electron" } })

        const clipboardBefore = await command({ type: "clipboard", action: "read" })
        const previousClipboard =
          clipboardBefore.type === "data" && typeof (clipboardBefore.data as { text?: unknown }).text === "string"
            ? (clipboardBefore.data as { text: string }).text
            : ""
        try {
          expect(await command({ type: "clipboard", action: "write", text: "Browser Host clipboard" })).toMatchObject({
            type: "data",
            data: { written: true },
          })
          expect(await command({ type: "clipboard", action: "read" })).toMatchObject({
            type: "data",
            data: { text: "Browser Host clipboard" },
          })
        } finally {
          await command({ type: "clipboard", action: "write", text: previousClipboard })
        }

        await expect(
          command({
            type: "evaluate",
            mode: "readonly",
            expression: `document.body.dataset.readonlyMutation = 'blocked'`,
          }),
        ).rejects.toMatchObject({ code: "browser_readonly_side_effect_rejected" })
        await expect(
          command({
            type: "action",
            action: {
              type: "click",
              target: { kind: "css", value: 'button:has-text("Continue with Holos")' },
            },
          }),
        ).rejects.toMatchObject({ code: "browser_invalid_selector" })
        expect(await command({ type: "screenshot", target: { kind: "role", role: "button" } })).toMatchObject({
          type: "screenshot",
          pageId: "electron-contract-page",
        })

        await request({
          type: "page.create",
          protocolVersion: BROWSER_PROTOCOL_VERSION,
          requestId: crypto.randomUUID(),
          ownerKey: browserOwnerKey({ mode: "scope", scopeID: "scope-2" }),
          owner: { mode: "scope", scopeID: "scope-2", directory },
          routeDirectory: "home",
          presentation: "webrtc",
          page: {
            id: "electron-contract-page-2",
            url: "about:blank",
            title: "",
            isLoading: false,
            lastActiveAt: null,
          },
          networkProxy: { server: serverUrl, username: "proxy-user-2", password: "proxy-password-2" },
          downloadDir: directory,
          signalingTicket: "host-signaling-ticket-2",
        })
        expect(
          await request({
            type: "page.command",
            protocolVersion: BROWSER_PROTOCOL_VERSION,
            requestId: crypto.randomUUID(),
            ownerKey: browserOwnerKey({ mode: "scope", scopeID: "scope-2" }),
            pageId: "electron-contract-page-2",
            command: { type: "evaluate", mode: "trusted", expression: "document.body.dataset.owner = 'second'" },
          }),
        ).toMatchObject({ type: "evaluation" })
        const scopeSignal = await waitFor(
          () => signalingURLs.find((url) => url.searchParams.get("pageId") === "electron-contract-page-2"),
          5_000,
          "scope-owned Host signaling",
        )
        expect(scopeSignal.pathname).toBe("/home/browser/webrtc/host")
        expect(scopeSignal.searchParams.get("mode")).toBe("scope")
        expect(scopeSignal.searchParams.has("sessionID")).toBe(false)
        expect(
          await command({ type: "evaluate", mode: "readonly", expression: "document.body.dataset.owner" }),
        ).toMatchObject({ type: "evaluation", value: null })
        await request({
          type: "page.close",
          protocolVersion: BROWSER_PROTOCOL_VERSION,
          requestId: crypto.randomUUID(),
          ownerKey: browserOwnerKey({ mode: "scope", scopeID: "scope-2" }),
          pageId: "electron-contract-page-2",
        })

        await request({
          type: "page.close",
          protocolVersion: BROWSER_PROTOCOL_VERSION,
          requestId: crypto.randomUUID(),
          ownerKey: browserOwnerKey({ mode: "session", scopeID: "scope", sessionID: "desktop-smoke" }),
          pageId: "electron-contract-page",
        })
      } catch (error) {
        child.kill("SIGTERM")
        await Promise.race([child.exited, new Promise((resolve) => setTimeout(resolve, 2_000))])
        const stdout = await new Response(child.stdout).text().catch(() => "")
        const stderr = await new Response(child.stderr).text().catch(() => "")
        throw new Error(`${error instanceof Error ? error.message : String(error)}\n${stdout}\n${stderr}`)
      } finally {
        child.kill("SIGTERM")
        await Promise.race([child.exited, new Promise((resolve) => setTimeout(resolve, 5_000))])
        if (child.exitCode === null) child.kill("SIGKILL")
        await server.stop(true)
      }

      async function command(command: BrowserBackendCommand): Promise<BrowserBackendResult> {
        return request({
          type: "page.command",
          protocolVersion: BROWSER_PROTOCOL_VERSION,
          requestId: crypto.randomUUID(),
          ownerKey: browserOwnerKey({ mode: "session", scopeID: "scope", sessionID: "desktop-smoke" }),
          pageId: "electron-contract-page",
          command,
        })
      }

      async function request(
        message: Extract<BrowserHostMessage, { type: "page.create" | "page.command" | "page.close" }>,
      ): Promise<BrowserBackendResult> {
        const socket = brokerSocket
        if (!socket) throw new Error("Browser Host broker socket is unavailable")
        const result = deferred<BrowserBackendResult>()
        pending.set(message.requestId, result)
        socket.send(JSON.stringify(message))
        return withTimeout(
          result.promise,
          35_000,
          message.type === "page.command" ? `${message.type}:${message.command.type}` : message.type,
        )
      }
    },
    90_000,
  )
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

async function waitFor<T>(read: () => T | undefined, timeoutMs: number, label: string): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() <= deadline) {
    const value = read()
    if (value !== undefined) return value
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`${label} timed out after ${timeoutMs}ms`)
}
