import { spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import path from "node:path"
import { type Config } from "./gen/types.gen.js"
import { createSynergyClient, type SynergyClientConfig } from "./client.js"
import { parseRuntimeReady, RUNTIME_READY_MAX_LENGTH, type RuntimeReady } from "./runtime-ready.js"

export type ManagedServerOptions = {
  mode: "managed"
  executable: string
  args?: string[]
  version: string
  home: string
  components: Readonly<Record<string, string>>
  hostname?: "127.0.0.1" | "localhost" | "::1"
  port?: number
  signal?: AbortSignal
  timeout?: number
  config?: Config
}

export type AttachedServerOptions = {
  mode: "attach"
  url: string
  headers?: SynergyClientConfig["headers"]
  fetch?: SynergyClientConfig["fetch"]
  signal?: AbortSignal
  version?: string
  components?: Readonly<Record<string, string>>
}

export type ServerOptions = ManagedServerOptions | AttachedServerOptions
export type SynergyServer = {
  url: string
  headers: SynergyClientConfig["headers"]
  owned: boolean
  pid?: number
  ready?: RuntimeReady
  close(): Promise<void>
  [Symbol.asyncDispose](): Promise<void>
}

function verifyComponents(selected: Readonly<Record<string, string>>, active: RuntimeReady["components"]) {
  for (const [id, version] of Object.entries(selected)) {
    if (!active.some((item) => item.id === id && item.version === version))
      throw new Error(`Runtime component ${id}@${version} is unavailable`)
  }
}

export async function createSynergyServer(options: ServerOptions): Promise<SynergyServer> {
  options.signal?.throwIfAborted()
  if (options.mode === "attach") {
    const url = new URL(options.url)
    if (!["http:", "https:"].includes(url.protocol)) throw new Error("Runtime URL must use HTTP or HTTPS")
    const client = createSynergyClient({ baseUrl: url.href, headers: options.headers, fetch: options.fetch })
    const health = await client.global.health({ signal: options.signal, throwOnError: true })
    if (!health.data?.healthy) throw new Error("Attached runtime is not healthy")
    if (options.version && health.data.version !== options.version) throw new Error("Attached runtime version mismatch")
    if (options.components) {
      const result = await client.global.capabilities({ signal: options.signal, throwOnError: true })
      verifyComponents(options.components, result.data?.components ?? [])
    }
    const close = async () => {}
    return {
      url: url.href.replace(/\/$/, ""),
      headers: options.headers,
      owned: false,
      close,
      [Symbol.asyncDispose]: close,
    }
  }
  if (!path.isAbsolute(options.executable)) throw new Error("An explicit absolute runtime executable is required")
  if (!options.home) throw new Error("An explicit runtime data home is required")
  const exactVersion = /^(?:local|\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/
  if (
    !exactVersion.test(options.version) ||
    Object.values(options.components).some((value) => !exactVersion.test(value))
  )
    throw new Error("Managed runtimes require exact host and component versions")
  const hostname = options.hostname ?? "127.0.0.1"
  if (!["127.0.0.1", "localhost", "::1"].includes(hostname)) throw new Error("Managed runtimes must bind to loopback")
  const port = options.port ?? 0
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid runtime port")
  const home = path.resolve(options.home)
  const token = randomBytes(32).toString("hex")
  const args = [
    ...(options.args ?? []),
    "server",
    `--hostname=${hostname}`,
    `--port=${port}`,
    "--managed-ready",
    "--no-banner",
    "--non-interactive",
  ]
  if (options.config?.logLevel) args.push(`--log-level=${options.config.logLevel}`)
  const proc = spawn(options.executable, args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      SYNERGY_HOME: home,
      SYNERGY_RUNTIME_ROOT: home,
      SYNERGY_SERVER_TOKEN: token,
      SYNERGY_EXPECT_VERSION: options.version,
      SYNERGY_COMPONENTS: JSON.stringify(options.components),
      SYNERGY_CONFIG_CONTENT: JSON.stringify(options.config ?? {}),
    },
  })
  const exited = new Promise<void>((resolve) => proc.once("close", () => resolve()))
  let closing: Promise<void> | undefined
  const close = () =>
    (closing ??= (async () => {
      options.signal?.removeEventListener("abort", stopOnAbort)
      if (proc.exitCode !== null || proc.signalCode !== null) {
        await exited
        return
      }
      proc.kill("SIGTERM")
      const deadline = setTimeout(() => proc.kill("SIGKILL"), 5_000)
      deadline.unref()
      try {
        await exited
      } finally {
        clearTimeout(deadline)
      }
    })())
  const stopOnAbort = () => {
    void close()
  }
  options.signal?.addEventListener("abort", stopOnAbort, { once: true })
  proc.stderr.on("data", () => {})
  try {
    const ready = await new Promise<RuntimeReady>((resolve, reject) => {
      const timeout = options.timeout ?? 30_000
      const deadline = setTimeout(
        () => fail(new Error(`Timeout waiting for runtime readiness after ${timeout}ms`)),
        timeout,
      )
      let buffer = ""
      let settled = false
      const abort = () => fail(options.signal?.reason ?? new Error("Runtime startup aborted"))
      const cleanup = () => {
        clearTimeout(deadline)
        options.signal?.removeEventListener("abort", abort)
      }
      function fail(error: unknown) {
        if (settled) return
        settled = true
        cleanup()
        reject(error)
      }
      proc.once("error", fail)
      proc.once("exit", (code, signal) => fail(new Error(`Runtime exited before readiness (${code ?? signal})`)))
      options.signal?.addEventListener("abort", abort, { once: true })
      proc.stdout.setEncoding("utf8")
      proc.stdout.on("data", (chunk: string) => {
        if (settled) return
        buffer += chunk
        try {
          let end: number
          while ((end = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, end).replace(/\r$/, "")
            buffer = buffer.slice(end + 1)
            const result = parseRuntimeReady(line)
            if (!result) continue
            const url = new URL(result.url)
            if (result.pid !== proc.pid || result.version !== options.version || path.resolve(result.home) !== home)
              throw new Error("Runtime readiness identity or version mismatch")
            if (
              url.protocol !== "http:" ||
              !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
              !url.port ||
              url.username ||
              url.password ||
              url.pathname !== "/" ||
              url.search ||
              url.hash
            )
              throw new Error("Invalid managed runtime endpoint")
            if (port && Number(url.port) !== port) throw new Error("Runtime port mismatch")
            verifyComponents(options.components, result.components)
            settled = true
            cleanup()
            resolve(result)
            return
          }
          if (buffer.length > RUNTIME_READY_MAX_LENGTH) throw new Error("Runtime readiness output exceeds its bound")
        } catch (error) {
          fail(error)
        }
      })
      if (options.signal?.aborted) abort()
    })
    if (options.signal?.aborted) throw options.signal.reason
    return {
      url: ready.url,
      headers: { authorization: `Bearer ${token}` },
      owned: true,
      pid: proc.pid,
      ready,
      close,
      [Symbol.asyncDispose]: close,
    }
  } catch (error) {
    await close()
    throw error
  }
}
