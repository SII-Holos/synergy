import fs from "node:fs/promises"
import path from "node:path"
import { AtomicFile } from "@ericsanchezok/synergy-harness/storage/atomic-file"
import { WorkspaceAccess } from "@ericsanchezok/synergy-harness/workspace/access"
import type { WorkspaceCatalog } from "@ericsanchezok/synergy-harness/workspace"
import type { ScopeTransfer } from "@ericsanchezok/synergy-harness/scope/transfer"
import { WorktreeProcess } from "./process"

export namespace WorktreeRelocation {
  export function workspace(info: WorkspaceCatalog.Info, relocate: ScopeTransfer.Relocate): WorkspaceCatalog.Info {
    if (info.type !== "git_worktree" || typeof info.metadata.originalCheckout !== "string") return info
    return { ...info, metadata: { ...info.metadata, originalCheckout: relocate(info.metadata.originalCheckout) } }
  }

  function inside(root: string, filename: string) {
    const relative = path.relative(root, filename)
    return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  }

  async function text(filename: string) {
    const stat = await fs.lstat(filename).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
    if (!stat) return undefined
    if (!stat.isFile() || stat.size > 64 * 1024) throw new Error("Invalid Git relocation metadata")
    const file = await fs.open(filename, "r")
    try {
      const bytes = Buffer.alloc(64 * 1024 + 1)
      let length = 0
      while (length < bytes.length) {
        const next = await file.read(bytes, length, bytes.length - length, length)
        if (!next.bytesRead) break
        length += next.bytesRead
      }
      const after = await file.stat()
      if (length !== stat.size || after.ino !== stat.ino || after.dev !== stat.dev || after.mtimeMs !== stat.mtimeMs)
        throw new Error("Git metadata changed during Home relocation")
      return bytes
        .subarray(0, length)
        .toString("utf8")
        .replace(/\r?\n$/, "")
    } finally {
      await file.close()
    }
  }

  export async function repairCopied(input: { sourceRoot: string; targetRoot: string; directories: string[] }) {
    const map = (filename: string) => {
      if (!inside(input.sourceRoot, filename))
        throw new Error(
          "Move the linked Git repository together with its Workspaces; external Git metadata cannot be relocated independently",
        )
      return path.join(input.targetRoot, path.relative(input.sourceRoot, filename))
    }
    const groups = new Map<string, Set<string>>()
    const pointers = new Map<string, string>()
    const metadata = new Map<string, string>()
    const verifyPointer = async (sourcePointer: string, gitdir: string) => {
      const targetPointer = map(sourcePointer)
      const expected = map(gitdir)
      const current = await text(targetPointer)
      if (!current?.startsWith("gitdir: ")) throw new Error("A linked Git Workspace was not copied with its Home")
      const location = await fs.realpath(path.resolve(path.dirname(targetPointer), current.slice(8)))
      if (location !== gitdir && location !== expected)
        throw new Error("Destination Git Workspace belongs to another repository")
      pointers.set(targetPointer, expected)
      return targetPointer
    }
    for (const directory of new Set(input.directories)) {
      const dotgit = path.join(directory, ".git")
      const stat = await fs.lstat(dotgit).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined
        throw error
      })
      if (!stat) continue
      if (stat.isSymbolicLink()) throw new Error("Git metadata cannot relocate through a symbolic link")
      const pointer = stat.isFile() ? await text(dotgit) : undefined
      if (pointer !== undefined && !pointer.startsWith("gitdir: ")) throw new Error("Invalid Git Workspace pointer")
      const gitdir = await fs.realpath(pointer ? path.resolve(directory, pointer.slice(8)) : dotgit)
      map(gitdir)
      const common = await text(path.join(gitdir, "commondir"))
      const repository = common ? await fs.realpath(path.resolve(gitdir, common)) : gitdir
      map(repository)
      if (!groups.has(repository)) groups.set(repository, new Set())
      if (pointer !== undefined) await verifyPointer(dotgit, gitdir)
    }
    for (const [repository, worktrees] of groups) {
      const root = path.join(repository, "worktrees")
      const entries = await fs.readdir(root, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return []
        throw error
      })
      if (entries.length > 10_000) throw new Error("Git relocation exceeds 10,000 worktrees")
      const targetEntries = await fs
        .readdir(map(root), { withFileTypes: true })
        .catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return []
          throw error
        })
      if (targetEntries.some((entry) => !entry.isDirectory() || !entries.some((source) => source.name === entry.name)))
        throw new Error("Destination Git repository contains unrelated worktrees")
      for (const entry of entries) {
        if (!entry.isDirectory()) throw new Error("Invalid linked Git metadata directory")
        const gitdir = path.join(root, entry.name)
        const back = await text(path.join(gitdir, "gitdir"))
        if (!back) throw new Error("Missing linked Git Workspace pointer")
        const sourcePointer = await fs.realpath(path.resolve(gitdir, back))
        const targetPointer = await verifyPointer(sourcePointer, gitdir)
        const backlink = await text(map(path.join(gitdir, "gitdir")))
        if (!backlink || ![sourcePointer, targetPointer].includes(path.resolve(map(gitdir), backlink)))
          throw new Error("Destination Git metadata belongs to another Workspace")
        const common = await text(path.join(gitdir, "commondir"))
        if (!common || (await fs.realpath(path.resolve(gitdir, common))) !== repository)
          throw new Error("Linked Git metadata belongs to another repository")
        if (path.isAbsolute(common)) metadata.set(map(path.join(gitdir, "commondir")), map(repository) + "\n")
        worktrees.add(path.dirname(targetPointer))
      }
    }
    await WorkspaceAccess.metadata([input.targetRoot], async () => {
      for (const [filename, gitdir] of pointers) {
        if (!inside(input.targetRoot, await fs.realpath(path.dirname(filename))))
          throw new Error("Relocated Git metadata escapes the target Home")
        await AtomicFile.writeFileAtomic(filename, `gitdir: ${gitdir}\n`, { durable: true })
      }
      for (const [filename, content] of metadata) await AtomicFile.writeFileAtomic(filename, content, { durable: true })
    })
    // Provenance: https://git-scm.com/docs/git-worktree#_commands (repair).
    // Repair copied main and linked trees together. Every linked destination is
    // checked first so Git cannot reconnect the copied repository to the source.
    for (const [repository, worktrees] of groups) {
      const target = map(repository)
      if (!inside(input.targetRoot, await fs.realpath(target)))
        throw new Error("Git repository escapes the target Home")
      const env = {
        GIT_DIR: undefined,
        GIT_WORK_TREE: undefined,
        GIT_COMMON_DIR: undefined,
        GIT_INDEX_FILE: undefined,
        GIT_CONFIG: undefined,
      }
      const config = await WorktreeProcess.run({
        command: ["git", "config", "--file", path.join(target, "config"), "--no-includes", "--get", "core.worktree"],
        directory: input.targetRoot,
        roots: [],
        metadata: true,
        env,
      })
      if (![0, 1].includes(config.exitCode)) throw new Error("Git worktree configuration could not be read")
      const configured = config.stdout.toString("utf8").replace(/\r?\n$/, "")
      if (path.isAbsolute(configured) && !inside(input.targetRoot, configured)) {
        const written = await WorktreeProcess.run({
          command: ["git", "config", "--file", path.join(target, "config"), "core.worktree", map(configured)],
          directory: input.targetRoot,
          roots: [input.targetRoot],
          metadata: true,
          env,
        })
        if (written.exitCode !== 0) throw new Error("Git worktree configuration could not be relocated")
      }
      if (!worktrees.size) continue
      const result = await WorktreeProcess.run({
        command: ["git", "--git-dir", target, "worktree", "repair", ...worktrees],
        directory: path.dirname(target),
        roots: [input.targetRoot],
        metadata: true,
        env,
      })
      if (result.exitCode !== 0) throw new Error(`Git worktree relocation failed: ${result.stderr.toString("utf8")}`)
    }
  }
}
