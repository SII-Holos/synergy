import fsSync from "node:fs"
import fs from "node:fs/promises"
import { createRequire } from "node:module"
import path from "node:path"
import { Global } from "@/global"

const PACKAGE_NAME = "@sii-holos/holos-cli"
const PACKAGED_ENTRY = path.join("lib", "holos-cli", "index.js")
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024
const TIMEOUT_MS = 30_000
const STALE_TEMP_AGE_MS = 60 * 60 * 1000

async function cleanupStaleTempDirectories(now = Date.now()): Promise<void> {
  const entries = await fs.readdir(Global.Path.state, { withFileTypes: true }).catch(() => [])
  await Promise.all(
    entries.flatMap((entry) => {
      if (!entry.isDirectory() || !entry.name.startsWith("clarus-cli-")) return []
      const directory = path.join(Global.Path.state, entry.name)
      return [
        fs
          .stat(directory)
          .then((stat) =>
            now - stat.mtimeMs >= STALE_TEMP_AGE_MS ? fs.rm(directory, { recursive: true, force: true }) : undefined,
          )
          .catch(() => undefined),
      ]
    }),
  )
}

async function removeCredentialDirectory(directory: string, config: string): Promise<void> {
  await fs.writeFile(config, "", { mode: 0o600 }).catch(() => undefined)
  await fs.rm(directory, { recursive: true, force: true })
}

type Credential = { agentId: string; agentSecret: string }

export type ClarusCliRunner = {
  json(args: string[]): Promise<unknown>
  download(args: string[], output: string): Promise<void>
}

function sourceEntry(): string | undefined {
  try {
    const require = createRequire(import.meta.url)
    const packageJson = require.resolve(`${PACKAGE_NAME}/package.json`)
    return path.join(path.dirname(packageJson), "dist", "index.js")
  } catch {
    return undefined
  }
}

export function resolveClarusCliEntry(execPath = process.execPath): string {
  const packaged = path.resolve(path.dirname(fsSync.realpathSync(execPath)), "..", PACKAGED_ENTRY)
  if (fsSync.existsSync(packaged)) return packaged
  const source = sourceEntry()
  if (source && fsSync.existsSync(source)) return source
  throw new Error("The bundled Holos CLI runtime is unavailable")
}

async function readBounded(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!stream) return ""
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  while (true) {
    const result = await reader.read()
    if (result.done) break
    size += result.value.byteLength
    if (size > MAX_OUTPUT_BYTES) throw new Error("Holos CLI output exceeded the allowed size")
    chunks.push(result.value)
  }
  const output = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(output)
}

export function createClarusCliRunner(input: {
  apiUrl: string
  credential: Credential
  entry?: string
}): ClarusCliRunner {
  const entry = input.entry ?? resolveClarusCliEntry()

  const run = async (args: string[]) => {
    await cleanupStaleTempDirectories()
    const directory = await fs.mkdtemp(path.join(Global.Path.state, "clarus-cli-"))
    await fs.chmod(directory, 0o700)
    const config = path.join(directory, "config.json")
    try {
      await fs.writeFile(
        config,
        JSON.stringify({
          api: input.apiUrl,
          agent_id: input.credential.agentId,
          agent_secret: input.credential.agentSecret,
        }),
        { mode: 0o600 },
      )
      const proc = Bun.spawn([process.execPath, entry, "clarus", "--config", config, "--json", ...args], {
        stdout: "pipe",
        stderr: "pipe",
        env: { BUN_BE_BUN: "1" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      const [code, stdout] = await Promise.all([proc.exited, readBounded(proc.stdout), readBounded(proc.stderr)])
      if (code !== 0) throw new Error(`Holos CLI failed with exit code ${code}`)
      return stdout
    } finally {
      await removeCredentialDirectory(directory, config)
    }
  }

  return {
    async json(args) {
      return JSON.parse(await run(args))
    },
    async download(args, output) {
      await fs.mkdir(path.dirname(output), { recursive: true, mode: 0o700 })
      await run([...args, "--output", output])
    },
  }
}
