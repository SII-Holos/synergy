import path from "path"
import { Log } from "../util/log"
import { z } from "zod"
import { Config } from "../config/config"
import { ScopeContext } from "../scope/context"
import { SnapshotSchema } from "./snapshot-schema"
import { SnapshotGit } from "./snapshot-git"
import { SnapshotCapture } from "./snapshot-capture"
import { SnapshotStore } from "./snapshot-store"
import { SnapshotLink } from "./snapshot-link"
import { SnapshotRestore } from "./snapshot-restore"
import { WorkspaceBinding } from "../workspace/binding"
import { ObservabilityMetrics } from "../observability/metrics"

export namespace Snapshot {
  const log = Log.create({ service: "snapshot" })
  async function gitSpawn(...args: Parameters<typeof SnapshotGit.run>) {
    const context = SnapshotStore.current()
    args[2] = { ...args[2], GIT_INDEX_FILE: context.index, GIT_LITERAL_PATHSPECS: "1" }
    return SnapshotGit.run(...args)
  }

  export async function track(sessionID: string, signal?: AbortSignal): Promise<string | undefined> {
    if (signal?.aborted) return
    const source = workspace()
    if (!source) return
    await WorkspaceBinding.validate(source.id, ScopeContext.current.scope.id, source.generation)
    if ((await Config.current()).snapshot === false) return
    try {
      return await SnapshotStore.withSession(sessionID, () => trackImpl(sessionID, signal), signal)
    } catch (error) {
      if (signal?.aborted) return undefined
      throw error
    }
  }

  export function workspace(): SnapshotSchema.Workspace | undefined {
    const source = ScopeContext.current.workspace
    if (!source?.id || !source.generation || source.bindingState === "unbound") return
    return { id: source.id, generation: source.generation, root: source.path }
  }

  async function trackImpl(sessionID: string, signal?: AbortSignal): Promise<string | undefined> {
    if (signal?.aborted) return
    const started = Date.now()
    log.debug("track start", { sessionID, cwd: ScopeContext.current.directory })
    const git = gitdir()
    await SnapshotStore.initialize(SnapshotStore.current())
    const addResult = await refreshIndex(sessionID, signal)
    if (!addResult) {
      log.warn("track add failed", { sessionID, duration: Date.now() - started })
      return undefined
    }
    const writeResult = await gitSpawn(
      ["git", "--git-dir", git, "write-tree"],
      ScopeContext.current.directory,
      undefined,
      signal,
    )
    if (writeResult.exitCode !== 0 || !writeResult.text.trim()) {
      log.warn("track write-tree failed", { sessionID, exitCode: writeResult.exitCode, duration: Date.now() - started })
      return undefined
    }
    const source = workspace()!
    await WorkspaceBinding.validate(source.id, ScopeContext.current.scope.id, source.generation)
    const hash = writeResult.text.trim()
    if (!(await SnapshotStore.retainCurrent(hash, signal))) return undefined
    log.info("tracking", { hash, cwd: ScopeContext.current.directory, git, duration: Date.now() - started })
    ObservabilityMetrics.record({
      name: "snapshot.track.duration",
      value: Date.now() - started,
      unit: "ms",
      module: "session",
      sessionID,
    })
    return hash
  }

  type IndexOptions = { indexFresh?: boolean; signal?: AbortSignal }

  export async function patch(hash: string, sessionID: string, options?: IndexOptions): Promise<Patch> {
    if (options?.signal?.aborted) return { hash, files: [] }
    return SnapshotStore.withSession(
      sessionID,
      async () => {
        if (!(await SnapshotStore.ownsCurrent(hash))) return { hash, files: [] }
        return patchImpl(hash, sessionID, options)
      },
      options?.signal,
    ).catch((error) => {
      if (options?.signal?.aborted) return { hash, files: [] }
      throw error
    })
  }

  export async function diff(hash: string, sessionID: string, options?: IndexOptions) {
    if (options?.signal?.aborted) return ""
    return SnapshotStore.withSession(
      sessionID,
      async () => {
        if (!(await SnapshotStore.ownsCurrent(hash))) return ""
        return diffImpl(hash, sessionID, options)
      },
      options?.signal,
    ).catch((error) => {
      if (options?.signal?.aborted) return ""
      throw error
    })
  }

  export async function changedPaths(from: string, to: string, sessionID: string, signal?: AbortSignal) {
    return SnapshotStore.withSession(
      sessionID,
      async () => {
        if (!(await SnapshotStore.ownsCurrent(from)) || !(await SnapshotStore.ownsCurrent(to)))
          throw new SnapshotStore.StorageError("Operation snapshot endpoints are unavailable")
        const result = await gitSpawn(
          [
            "git",
            "--git-dir",
            gitdir(),
            "diff",
            "--no-ext-diff",
            "--no-renames",
            "--name-only",
            "-z",
            from,
            to,
            "--",
            ".",
          ],
          path.dirname(gitdir()),
          undefined,
          signal,
        )
        if (result.exitCode !== 0) throw new SnapshotStore.StorageError("Operation snapshot comparison failed")
        return result.text.split("\0").filter(Boolean)
      },
      signal,
      { historical: true },
    )
  }

  export async function diffSummary(from: string, to: string, sessionID: string, signal?: AbortSignal) {
    if (signal?.aborted) return []
    return SnapshotStore.withSession(
      sessionID,
      async () => {
        if (!(await SnapshotStore.ownsCurrent(from)) || !(await SnapshotStore.ownsCurrent(to))) return []
        return diffSummaryImpl(from, to, sessionID, signal)
      },
      signal,
      { historical: true },
    ).catch((error) => {
      if (signal?.aborted) return []
      throw error
    })
  }

  export async function revert(
    patches: Patch[],
    sessionID: string,
    signal?: AbortSignal,
  ): Promise<SnapshotRestore.Result> {
    if (!patches.some((patch) => patch.files.length)) return { restoredFiles: [], failedFiles: [] }
    return SnapshotStore.withSession(
      sessionID,
      async () => {
        const files = new Map<string, SnapshotRestore.File>()
        const trees = new Map<string, Map<string, { mode: string; oid: string }>>()
        for (const patch of patches) {
          if (!patch.files.length) continue
          const source = patch.workspace
          if (!source)
            throw new SnapshotRestore.Invalid({ message: "This historical patch has no verified Workspace binding" })
          const binding = await WorkspaceBinding.validate(source.id, ScopeContext.current.scope.id, source.generation)
          if (binding.path !== source.root)
            throw new SnapshotRestore.Invalid({
              message: "The historical Workspace location does not match its binding",
            })
          if (!(await SnapshotStore.ownsCurrent(patch.hash)))
            throw new SnapshotRestore.Invalid({
              message: "The historical file snapshot is unavailable to this session",
            })
          let tree = trees.get(patch.hash)
          if (!tree) {
            const listing = await gitSpawn(
              ["git", "--git-dir", gitdir(), "ls-tree", "-r", "-l", "-z", patch.hash],
              path.dirname(gitdir()),
              undefined,
              signal,
            )
            if (listing.exitCode !== 0)
              throw new SnapshotRestore.Invalid({ message: "The historical file tree could not be read" })
            tree = new Map(
              listing.text
                .split("\0")
                .filter(Boolean)
                .map((entry) => {
                  const boundary = entry.indexOf("\t")
                  const [mode, kind, oid, size] = entry.slice(0, boundary).trim().split(/\s+/)
                  if (boundary < 0 || !SnapshotStore.OID.test(oid))
                    throw new SnapshotRestore.Invalid({
                      message: "The historical file tree contains an unsupported entry",
                    })
                  return [
                    entry.slice(boundary + 1),
                    { mode: kind === "blob" && Number(size) <= 50 * 1024 * 1024 ? mode : "unsupported", oid },
                  ]
                }),
            )
            trees.set(patch.hash, tree)
          }
          for (const file of patch.files) {
            signal?.throwIfAborted()
            const relative = path.relative(source.root, file)
            if (
              !path.isAbsolute(file) ||
              !relative ||
              relative === ".." ||
              relative.startsWith(`..${path.sep}`) ||
              path.isAbsolute(relative)
            )
              throw new SnapshotRestore.Invalid({ message: "A historical file is outside its Workspace" })
            const normalized = path.normalize(file)
            if (files.has(normalized)) continue
            const entry = tree.get(process.platform === "win32" ? relative.replaceAll("\\", "/") : relative)
            if (entry && !["100644", "100755", "120000"].includes(entry.mode))
              throw new SnapshotRestore.Invalid({ message: "This snapshot file mode cannot be restored" })
            files.set(normalized, {
              file: normalized,
              workspace: source,
              mode: entry ? (entry.mode as "100644" | "100755" | "120000") : null,
              async read() {
                if (!entry) return new Uint8Array()
                const result = await gitSpawn(
                  ["git", "--git-dir", gitdir(), "cat-file", "blob", entry.oid],
                  path.dirname(gitdir()),
                  undefined,
                  signal,
                )
                if (result.exitCode !== 0)
                  throw new SnapshotRestore.Invalid({ message: "The historical file content is unavailable" })
                return result.bytes
              },
            })
          }
        }
        return SnapshotRestore.apply({ files: [...files.values()], signal })
      },
      signal,
      { historical: true },
    )
  }

  export const Patch = z.object({
    hash: z.string(),
    workspace: SnapshotSchema.Workspace.optional(),
    files: z.string().array(),
  })
  export type Patch = z.infer<typeof Patch>

  async function patchImpl(hash: string, sessionID: string, opts?: IndexOptions): Promise<Patch> {
    if (opts?.signal?.aborted) return { hash, files: [] }
    const started = Date.now()
    log.debug("patch start", { sessionID, hash })
    const git = gitdir()
    if (!opts?.indexFresh) {
      const addResult = await refreshIndex(sessionID, opts?.signal)
      if (!addResult) {
        log.warn("patch add failed", { sessionID, hash, duration: Date.now() - started })
        return { hash, files: [] }
      }
    }
    if (opts?.signal?.aborted) return { hash, files: [] }
    const diffResult = await gitSpawn(
      [
        "git",
        "-c",
        "core.autocrlf=false",
        "--git-dir",
        git,
        "diff",
        "--no-ext-diff",
        "--name-only",
        "--cached",
        "-z",
        hash,
        "--",
        ".",
      ],
      ScopeContext.current.directory,
      undefined,
      opts?.signal,
    )

    if (diffResult.exitCode !== 0) {
      log.warn("failed to get diff", {
        sessionID,
        hash,
        exitCode: diffResult.exitCode,
        stderr: diffResult.stderr,
        duration: Date.now() - started,
      })
      return { hash, files: [] }
    }

    const filesText = diffResult.text
    log.debug("patch done", { sessionID, hash, duration: Date.now() - started })
    ObservabilityMetrics.record({
      name: "snapshot.patch.duration",
      value: Date.now() - started,
      unit: "ms",
      module: "session",
      sessionID,
    })
    return {
      hash,
      workspace: workspace(),
      files: filesText.split("\0").filter(Boolean).map(absoluteWorktreePath),
    }
  }

  async function diffImpl(hash: string, sessionID: string, opts?: IndexOptions) {
    const git = gitdir()
    if (!opts?.indexFresh) await refreshIndex(sessionID, opts?.signal)
    const result = await gitSpawn(
      ["git", "-c", "core.autocrlf=false", "--git-dir", git, "diff", "--no-ext-diff", "--cached", hash, "--", "."],
      ScopeContext.current.directory,
      undefined,
      opts?.signal,
    )

    if (result.exitCode !== 0) {
      log.warn("failed to get diff", {
        hash,
        exitCode: result.exitCode,
        stderr: result.stderr,
        stdout: result.text,
      })
      return ""
    }

    return result.text.trim()
  }

  export const FileDiff = SnapshotSchema.FileDiff
  export type FileDiff = SnapshotSchema.FileDiff
  async function diffSummaryImpl(
    from: string,
    to: string,
    sessionID: string,
    signal?: AbortSignal,
  ): Promise<FileDiff[]> {
    const git = gitdir()
    const result: FileDiff[] = []
    const diff = await gitSpawn(
      [
        "git",
        "-c",
        "core.autocrlf=false",
        "-c",
        "core.quotepath=false",
        "--git-dir",
        git,
        "diff",
        "--no-ext-diff",
        "--no-renames",
        "--numstat",
        "-p",
        "-z",
        from,
        to,
        "--",
        ".",
      ],
      path.dirname(git),
      undefined,
      signal,
    )
    if (diff.exitCode !== 0) {
      log.warn("failed to get diff summary", { from, to, exitCode: diff.exitCode, stderr: diff.stderr })
      return result
    }

    const parsed = parseNumstatPatch(diff.text)
    const entries = await objectEntries(
      git,
      parsed.stats.flatMap((stat) => [
        { tree: from, file: stat.file },
        { tree: to, file: stat.file },
      ]),
      signal,
    )
    for (let index = 0; index < parsed.stats.length; index++) {
      const stat = parsed.stats[index]
      const { additions, deletions, file } = stat
      const isBinaryFile = additions === "-" && deletions === "-"
      const before = entries.get(objectSizeKey(from, file))
      const after = entries.get(objectSizeKey(to, file))
      if (isBinaryFile && (before?.mode === "120000" || after?.mode === "120000")) {
        const describe = async (entry: TreeEntry | undefined) => {
          if (!entry) return ""
          if (entry.mode !== "120000") return `File (${entry.size} bytes)`
          if (entry.size > 256 * 1024) throw new SnapshotStore.StorageError("Snapshot link exceeds its size limit")
          const content = await gitSpawn(
            ["git", "--git-dir", git, "cat-file", "blob", entry.oid],
            path.dirname(git),
            undefined,
            signal,
          )
          if (content.exitCode !== 0) throw new SnapshotStore.StorageError("Snapshot link is unavailable")
          return SnapshotLink.display(SnapshotLink.decode(content.bytes))
        }
        const descriptions = await Promise.all([describe(before), describe(after)])
        result.push({
          ...SnapshotSchema.fromContents({
            file,
            before: descriptions[0],
            after: descriptions[1],
            additions: after ? 1 : 0,
            deletions: before ? 1 : 0,
          }),
          beforeBytes: before?.size,
          afterBytes: after?.size,
        })
        continue
      }
      const added = isBinaryFile ? 0 : parseInt(additions)
      const deleted = isBinaryFile ? 0 : parseInt(deletions)
      const patch = isBinaryFile ? "" : (parsed.patches[index] ?? "")
      result.push(
        SnapshotSchema.fromPatch({
          file,
          additions: Number.isFinite(added) ? added : 0,
          deletions: Number.isFinite(deleted) ? deleted : 0,
          binary: isBinaryFile,
          patch,
          beforeBytes: before?.size,
          afterBytes: after?.size,
        }),
      )
    }
    return SnapshotSchema.boundArray(result)
  }

  async function refreshIndex(sessionID: string, signal?: AbortSignal): Promise<boolean> {
    try {
      return await SnapshotCapture.refresh(SnapshotStore.current(), signal)
    } catch (error) {
      log.warn("snapshot capture failed", { sessionID, error })
      return false
    }
  }

  function absoluteWorktreePath(rel: string): string {
    return path.join(ScopeContext.current.directory, rel)
  }

  function parseNumstatPatch(text: string): {
    stats: Array<{ additions: string; deletions: string; file: string }>
    patches: string[]
  } {
    // Provenance: https://git-scm.com/docs/git-diff (-z and --numstat).
    // NUL-delimited statistics preserve literal names; patch headers are display text.
    const boundary = text.indexOf("\0\0")
    const stats = boundary < 0 ? text : text.slice(0, boundary)
    return {
      stats: stats
        .split("\0")
        .filter(Boolean)
        .map((record) => {
          const first = record.indexOf("\t")
          const second = record.indexOf("\t", first + 1)
          if (first < 0 || second < 0) throw new SnapshotStore.StorageError("Invalid snapshot diff statistics")
          return {
            additions: record.slice(0, first),
            deletions: record.slice(first + 1, second),
            file: record.slice(second + 1),
          }
        }),
      patches: splitPatches(boundary < 0 ? "" : text.slice(boundary + 2)),
    }
  }

  function splitPatches(text: string) {
    if (!text.trim()) return []
    return text
      .split(/^diff --git /m)
      .filter(Boolean)
      .map((patch) => `diff --git ${patch}`)
  }

  function objectSizeKey(tree: string, file: string) {
    return `${tree}:${file}`
  }

  interface TreeEntry {
    mode: string
    oid: string
    size: number
  }

  async function objectEntries(
    git: string,
    objects: Array<{ tree: string; file: string }>,
    signal?: AbortSignal,
  ): Promise<Map<string, TreeEntry>> {
    const result = new Map<string, TreeEntry>()
    if (objects.length === 0) return result
    const requested = new Set(objects.map((object) => objectSizeKey(object.tree, object.file)))
    // Provenance: https://git-scm.com/docs/git-ls-tree (-l -z).
    // Tree entries carry sizes without interpolating filenames into a line protocol.
    for (const tree of new Set(objects.map((object) => object.tree))) {
      const listing = await gitSpawn(
        ["git", "--git-dir", git, "ls-tree", "-r", "-l", "-z", tree],
        path.dirname(git),
        undefined,
        signal,
      )
      if (listing.exitCode !== 0) throw new SnapshotStore.StorageError("Snapshot tree metadata is unavailable")
      for (const entry of listing.text.split("\0")) {
        if (!entry) continue
        const separator = entry.indexOf("\t")
        const [mode, , oid, size] = entry.slice(0, separator).trim().split(/\s+/)
        const key = objectSizeKey(tree, entry.slice(separator + 1))
        if (requested.has(key) && /^\d+$/.test(size)) result.set(key, { mode, oid, size: Number(size) })
      }
    }
    return result
  }

  function gitdir() {
    return SnapshotStore.current().repository
  }
}
