import path from "node:path"
import z from "zod"
import { Installation } from "../../global/installation"
import { ScopeContext } from "../../scope/context"
import { SessionPluginHooks } from "../plugin-hooks"

export namespace RolloutProvenance {
  const Hash = z.string().regex(/^[a-f0-9]{64}$/)
  const Git = z
    .object({
      commit: z.string().regex(/^[a-f0-9]{40,64}$/),
      dirty: z.boolean(),
      statusSha256: Hash,
      trackedDiffSha256: Hash,
    })
    .strict()
  export const Info = z
    .object({
      version: z.literal(1),
      capturedAt: z.number(),
      code: z.object({ version: z.string(), commit: z.string().nullable(), checkout: Git.nullable() }).strict(),
      workspace: Git.nullable(),
      installedPlugins: z.array(
        z.object({ id: z.string(), version: z.string(), generation: z.string(), manifestHash: z.string() }).strict(),
      ),
    })
    .strict()
  export type Info = z.infer<typeof Info>

  async function command(directory: string, args: string[], text = false) {
    let process: Bun.Subprocess<"ignore", "pipe", "ignore">
    try {
      process = Bun.spawn(["git", "--no-optional-locks", ...args], {
        cwd: directory,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "ignore",
      })
    } catch {
      return undefined
    }
    const timeout = setTimeout(() => process.kill(), 5000)
    const reader = process.stdout.getReader()
    const hash = new Bun.CryptoHasher("sha256")
    let value = "",
      bytes = 0
    try {
      while (true) {
        const { done, value: chunk } = await reader.read()
        if (done) break
        hash.update(chunk)
        bytes += chunk.byteLength
        if (text && bytes <= 1024) value += new TextDecoder().decode(chunk)
      }
      if ((await process.exited) !== 0) return undefined
      return { value: value.trim(), bytes, sha256: hash.digest("hex") }
    } finally {
      clearTimeout(timeout)
      reader.releaseLock()
    }
  }

  export async function git(directory: string): Promise<z.infer<typeof Git> | null> {
    const commit = await command(directory, ["rev-parse", "--verify", "HEAD"], true)
    if (!commit || !/^[a-f0-9]{40,64}$/.test(commit.value)) return null
    const [status, diff] = await Promise.all([
      command(directory, ["status", "--porcelain=v1", "--untracked-files=normal"]),
      command(directory, ["diff", "HEAD", "--binary", "--no-ext-diff"]),
    ])
    if (!status || !diff) return null
    return {
      commit: commit.value,
      dirty: status.bytes > 0,
      statusSha256: status.sha256,
      trackedDiffSha256: diff.sha256,
    }
  }

  export async function capture(): Promise<Info> {
    const directory = ScopeContext.tryScope()?.directory
    const [checkout, workspace, installedPlugins] = await Promise.all([
      Installation.isLocal() ? git(path.resolve(import.meta.dirname, "../../../../..")) : null,
      directory ? git(directory) : null,
      SessionPluginHooks.installed(),
    ])
    return Info.parse({
      version: 1,
      capturedAt: Date.now(),
      code: { version: Installation.VERSION, commit: Installation.COMMIT ?? checkout?.commit ?? null, checkout },
      workspace,
      installedPlugins,
    })
  }
}
