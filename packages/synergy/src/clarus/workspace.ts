import path from "path"
import fs from "fs/promises"
import { Filesystem } from "@/util/filesystem"
import { Lock } from "@/util/lock"
import type { ClarusConfig } from "./schemas"
import { validateSegment } from "./keys"

let config: ClarusConfig | undefined
let canonicalRoot: string | undefined

export namespace ClarusWorkspace {
  export function configure(cfg: ClarusConfig): void {
    const resolved = path.resolve(cfg.workspaceRoot)
    const sanitized = Filesystem.sanitizePath(resolved)
    config = { workspaceRoot: sanitized }
    canonicalRoot = sanitized
  }

  function requireConfig(): ClarusConfig {
    if (!config) throw new Error("ClarusWorkspace not configured — call ClarusWorkspace.configure() first")
    return config
  }

  function requireCanonicalRoot(): string {
    if (!canonicalRoot) throw new Error("ClarusWorkspace not configured — call ClarusWorkspace.configure() first")
    return canonicalRoot
  }

  export function resolveWorkspacePath(input: { agentId: string; projectId: string }): string {
    const root = requireCanonicalRoot()
    const hasher = new Bun.CryptoHasher("sha256")
    hasher.update("clarus:")
    hasher.update(input.agentId)
    hasher.update(":")
    hasher.update(input.projectId)
    const hash = hasher.digest("hex").slice(0, 20)
    return path.join(root, hash, "workspace")
  }

  export async function ensureWorkspace(input: { agentId: string; projectId: string }): Promise<string> {
    validateSegment(input.agentId)
    validateSegment(input.projectId)

    const root = requireCanonicalRoot()
    const wsPath = resolveWorkspacePath(input)
    await ensureDirectoryChain(root)
    await ensureDirectoryChain(path.dirname(wsPath))
    await ensureDirectoryChain(wsPath)

    const [realRoot, realWorkspace] = await Promise.all([fs.realpath(root), fs.realpath(wsPath)])
    if (realWorkspace !== realRoot && !realWorkspace.startsWith(`${realRoot}${path.sep}`)) {
      throw new Error("Clarus workspace escapes configured root")
    }
    return wsPath
  }

  async function ensureDirectoryChain(target: string): Promise<void> {
    const resolved = path.resolve(target)
    const parsed = path.parse(resolved)
    let current = parsed.root
    for (const segment of resolved.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
      current = path.join(current, segment)
      try {
        await fs.mkdir(current)
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error
      }
      const stat = await fs.lstat(current)
      if (stat.isSymbolicLink()) throw new Error("Clarus workspace path must not contain symlinks")
      if (!stat.isDirectory()) throw new Error("Clarus workspace path component is not a directory")
    }
  }

  export async function lockWorkspace(input: { agentId: string; projectId: string }): Promise<Disposable> {
    validateSegment(input.agentId)
    validateSegment(input.projectId)
    const wsPath = resolveWorkspacePath(input)
    return Lock.write(`clarus:workspace:${encodeURIComponent(wsPath)}`)
  }
}
