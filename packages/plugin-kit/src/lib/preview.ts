import { mkdtemp, mkdir, writeFile, rm, open, type FileHandle } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { createServer } from "node:net"
import { createSynergyClient } from "@ericsanchezok/synergy-sdk/client"
import { PluginManifest } from "@ericsanchezok/synergy-plugin"

export interface PluginPreviewOptions {
  artifacts: readonly string[]
  command?: readonly string[]
  startupTimeoutMs?: number
  signal?: AbortSignal
}

async function availablePort() {
  const socket = createServer()
  await new Promise<void>((resolve, reject) => {
    socket.once("error", reject)
    socket.listen(0, "127.0.0.1", resolve)
  })
  const address = socket.address()
  await new Promise<void>((resolve, reject) => socket.close((error) => (error ? reject(error) : resolve())))
  if (!address || typeof address === "string") throw new Error("Could not reserve a preview port")
  return address.port
}

export async function startPluginPreview(options: PluginPreviewOptions) {
  options.signal?.throwIfAborted()
  if (!options.artifacts.length) throw new Error("Preview requires at least one built plugin artifact")
  if (options.command && !options.command.length) throw new Error("Preview host command must not be empty")
  const artifacts = await Promise.all(
    options.artifacts.map(async (directory) => {
      const resolved = path.resolve(directory)
      const manifest = PluginManifest.parse(await Bun.file(path.join(resolved, "plugin.json")).json())
      return { directory: resolved, manifest }
    }),
  )
  const port = await availablePort()
  const home = await mkdtemp(path.join(tmpdir(), "synergy-plugin-preview-"))
  let log: FileHandle | undefined
  let child: ReturnType<typeof Bun.spawn> | undefined
  const client = createSynergyClient({ baseUrl: `http://127.0.0.1:${port}` })
  let closing: Promise<void> | undefined
  const close = () =>
    (closing ??= (async () => {
      options.signal?.removeEventListener("abort", abort)
      if (child && child.exitCode === null) {
        child.kill("SIGTERM")
        const forced = setTimeout(() => {
          if (child && child.exitCode === null) child.kill("SIGKILL")
        }, 5000)
        try {
          await child.exited
        } finally {
          clearTimeout(forced)
        }
      }
      await log?.close()
      await rm(home, { recursive: true, force: true })
    })())
  const abort = () => {
    void close().catch(() => {})
  }
  try {
    const config = path.join(home, ".synergy/config/synergy.d")
    await mkdir(config, { recursive: true })
    await writeFile(
      path.join(config, "50-plugins.jsonc"),
      JSON.stringify({ plugin: artifacts.map(({ directory }) => pathToFileURL(directory).href) }),
    )
    log = await open(path.join(home, "host.log"), "w")
    options.signal?.throwIfAborted()
    const env: Record<string, string> = {}
    for (const key of ["PATH", "SystemRoot", "COMSPEC", "PATHEXT", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL"]) {
      if (process.env[key]) env[key] = process.env[key]!
    }
    child = Bun.spawn(
      [
        ...(options.command ?? ["synergy"]),
        "server",
        "--hostname",
        "127.0.0.1",
        "--port",
        String(port),
        "--non-interactive",
        "--no-banner",
      ],
      {
        cwd: home,
        env: {
          ...env,
          SYNERGY_HOME: home,
          SYNERGY_DISABLE_AUTOUPDATE: "1",
          SYNERGY_DISABLE_DEFAULT_PLUGINS: "1",
          SYNERGY_DISABLE_CLAUDE_CODE: "1",
        },
        stdin: "ignore",
        stdout: log.fd,
        stderr: log.fd,
      },
    )
    options.signal?.addEventListener("abort", abort, { once: true })
    options.signal?.throwIfAborted()
    const deadline = Date.now() + (options.startupTimeoutMs ?? 60000)
    while (true) {
      options.signal?.throwIfAborted()
      if (child.exitCode !== null)
        throw new Error(
          `Preview host exited with code ${child.exitCode}: ${await Bun.file(path.join(home, "host.log")).text()}`,
        )
      if (Date.now() >= deadline) throw new Error("Preview host did not become healthy before its startup deadline")
      const health = await client.global.health({ signal: AbortSignal.timeout(1000) }).catch(() => undefined)
      if (health?.data?.healthy) break
      await Bun.sleep(100)
    }
    return {
      home,
      url: `http://127.0.0.1:${port}/?plugin-preview=1`,
      client,
      plugins: artifacts.map(({ manifest }) => manifest),
      exited: child.exited,
      close,
    }
  } catch (error) {
    await close()
    throw error
  }
}
