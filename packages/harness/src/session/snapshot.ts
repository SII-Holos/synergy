import { WorkspaceTree } from "../workspace/tree"
import path from "path"
import { Log } from "../util/log"
import { z } from "zod"
import { Config } from "../config/config"
import { ScopeContext } from "../scope/context"
import { SnapshotSchema } from "./snapshot-schema"
import { SnapshotGit } from "./snapshot-git"
import { SnapshotCapture } from "./snapshot-capture"
import { SnapshotDurability } from "./snapshot-durability"
import { SnapshotStore } from "./snapshot-store"
import { SnapshotLink } from "./snapshot-link"
import { SnapshotRestore } from "./snapshot-restore"
import { WorkspaceBinding } from "../workspace/binding"
import { ObservabilityMetrics } from "../observability/metrics"
import { WorkspaceCatalog } from "../workspace/catalog"
import { WorkspaceContent } from "../workspace/content"

export namespace Snapshot {
  const log = Log.create({ service: "snapshot" })
  async function gitSpawn(...args: Parameters<typeof SnapshotGit.run>) {
    const context = SnapshotStore.current()
    args[2] = { ...args[2], GIT_INDEX_FILE: context.index, GIT_LITERAL_PATHSPECS: "1" }
    return SnapshotGit.run(...args)
  }

  export async function track(
    sessionID: string,
    signal?: AbortSignal,
    onOmissions?: (omissions: SnapshotSchema.Omission[]) => void,
  ): Promise<string | undefined> {
    if (signal?.aborted) return
    const source = workspace()
    if (!source) return
    await WorkspaceBinding.validate(source.id, ScopeContext.current.scope.id, source.generation)
    if ((await Config.current()).snapshot === false) return
    const started = performance.now()
    try {
      return await SnapshotStore.withSession(sessionID, () => trackImpl(sessionID, signal, onOmissions), signal)
    } catch (error) {
      if (signal?.aborted) return undefined
      throw error
    } finally {
      ObservabilityMetrics.record({
        name: "snapshot.track.total.duration",
        value: performance.now() - started,
        unit: "ms",
        module: "session",
        sessionID,
        scopeID: ScopeContext.current.scope.id,
      })
    }
  }

  export function workspace(): SnapshotSchema.Workspace | undefined {
    const source = ScopeContext.current.workspace
    if (!source?.id || !source.generation || source.bindingState === "unbound") return
    return { id: source.id, generation: source.generation, root: source.path }
  }

  export async function trackContent(
    info: WorkspaceCatalog.Info,
    manifest: string | null,
    sessionID: string,
    signal?: AbortSignal,
    onOmissions?: (omissions: SnapshotSchema.Omission[]) => void,
  ) {
    const source: SnapshotSchema.Workspace = {
      id: info.id,
      generation: info.binding.generation,
      root: "",
      pathKind: "workspace",
    }
    const { store } = await WorkspaceContent.resolve(
      { workspaceID: info.id, scopeID: info.scopeID, generation: info.binding.generation },
      true,
    )
    const tree = await WorkspaceContent.manifest(
      { ...info, content: { revision: info.content?.revision ?? 0, manifest } },
      store,
    )
    const started = performance.now()
    return SnapshotStore.withSession(
      sessionID,
      async () => {
        const operation = SnapshotStore.current()
        await phase("initialize", () => SnapshotStore.initialize(operation))
        await SnapshotCapture.refresh(operation, signal, { tree, store }, onOmissions)
        const options = await SnapshotDurability.treeOptions(operation.repository, signal)
        const result = await phase("tree", () =>
          gitSpawn(
            ["git", ...options, "--git-dir", operation.repository, "write-tree"],
            path.dirname(operation.repository),
            undefined,
            signal,
          ),
        )
        if (result.exitCode !== 0 || !result.text.trim())
          throw new SnapshotStore.StorageError("Snapshot content could not be retained")
        const hash = result.text.trim()
        if (!(await phase("retain", () => SnapshotStore.retainCurrent(hash, signal))))
          throw new SnapshotStore.StorageError("Snapshot retention failed")
        return hash
      },
      signal,
      { source },
    ).finally(() =>
      ObservabilityMetrics.record({
        name: "snapshot.track.total.duration",
        value: performance.now() - started,
        unit: "ms",
        module: "session",
        sessionID,
        scopeID: info.scopeID,
      }),
    )
  }

  async function phase<T>(name: string, fn: () => Promise<T>) {
    const started = performance.now()
    try {
      return await fn()
    } finally {
      const operation = SnapshotStore.current()
      ObservabilityMetrics.record({
        name: `snapshot.track.${name}.duration`,
        value: performance.now() - started,
        unit: "ms",
        module: "storage",
        sessionID: operation.sessionID,
        scopeID: operation.scopeID,
      })
    }
  }

  async function trackImpl(
    sessionID: string,
    signal?: AbortSignal,
    onOmissions?: (omissions: SnapshotSchema.Omission[]) => void,
  ): Promise<string | undefined> {
    if (signal?.aborted) return
    const started = Date.now()
    log.debug("track start", { sessionID, cwd: ScopeContext.current.directory })
    const git = gitdir()
    await phase("initialize", () => SnapshotStore.initialize(SnapshotStore.current()))
    const addResult = await refreshIndex(sessionID, signal, onOmissions)
    if (!addResult) {
      log.warn("track add failed", { sessionID, duration: Date.now() - started })
      return undefined
    }
    const options = await SnapshotDurability.treeOptions(git, signal)
    const writeResult = await phase("tree", () =>
      gitSpawn(["git", ...options, "--git-dir", git, "write-tree"], ScopeContext.current.directory, undefined, signal),
    )
    if (writeResult.exitCode !== 0 || !writeResult.text.trim()) {
      log.warn("track write-tree failed", { sessionID, exitCode: writeResult.exitCode, duration: Date.now() - started })
      return undefined
    }
    const source = workspace()!
    await WorkspaceBinding.validate(source.id, ScopeContext.current.scope.id, source.generation)
    const hash = writeResult.text.trim()
    if (!(await phase("retain", () => SnapshotStore.retainCurrent(hash, signal)))) return undefined
    log.info("tracking", { hash, cwd: ScopeContext.current.directory, git, duration: Date.now() - started })
    ObservabilityMetrics.record({
      name: "snapshot.track.duration",
      value: Date.now() - started,
      unit: "ms",
      module: "session",
      sessionID,
      scopeID: ScopeContext.current.scope.id,
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
    signal?.throwIfAborted()
    return SnapshotStore.withSession(
      sessionID,
      async () => {
        if (!(await SnapshotStore.ownsCurrent(from)) || !(await SnapshotStore.ownsCurrent(to)))
          throw new SnapshotStore.StorageError("Snapshot comparison endpoints are unavailable")
        return diffSummaryImpl(from, to, sessionID, signal)
      },
      signal,
      { historical: true },
    )
  }

  export async function previewRestore(patches: Patch[], sessionID: string, signal?: AbortSignal) {
    return withRestoreFiles(patches, sessionID, signal, (files) => SnapshotRestore.preview({ files, signal }))
  }
  export async function fileDiff(from: string, to: string, file: string, sessionID: string, signal?: AbortSignal) {
    SnapshotSchema.FilePath.parse(file)
    return SnapshotStore.withSession(
      sessionID,
      async () => {
        if (!(await SnapshotStore.ownsCurrent(from)) || !(await SnapshotStore.ownsCurrent(to)))
          throw new SnapshotStore.StorageError("Snapshot comparison endpoints are unavailable")
        const diff = (await diffSummaryImpl(from, to, sessionID, signal, file))[0]
        if (!diff) return
        const git = gitdir()
        const entries = await objectEntries(
          git,
          [
            { tree: from, file },
            { tree: to, file },
          ],
          signal,
        )
        if ([...entries.values()].some((entry) => entry.size > 1024 * 1024)) return { ...diff, patch: undefined }
        const canonical = await gitSpawn(
          [
            "git",
            "--git-dir",
            git,
            "--literal-pathspecs",
            "diff",
            "--binary",
            "--no-ext-diff",
            "--no-textconv",
            "--no-renames",
            from,
            to,
            "--",
            file,
          ],
          path.dirname(git),
          undefined,
          signal,
        )
        if (canonical.exitCode !== 0) throw new SnapshotStore.StorageError("Historical patch is unavailable")
        return { ...diff, patch: canonical.text }
      },
      signal,
      { historical: true },
    )
  }

  export async function fileVersions(
    from: string,
    to: string,
    file: string,
    sessionID: string,
    signal?: AbortSignal,
  ): Promise<SnapshotSchema.FileVersions> {
    const filename = SnapshotSchema.FilePath.parse(file)
    return SnapshotStore.withSession(
      sessionID,
      async () => {
        if (!(await SnapshotStore.ownsCurrent(from)) || !(await SnapshotStore.ownsCurrent(to)))
          throw new SnapshotStore.StorageError("Snapshot ownership is unavailable")
        const git = gitdir()
        const entries = await objectEntries(
          git,
          [
            { tree: from, file: filename },
            { tree: to, file: filename },
          ],
          signal,
        )
        const read = async (tree: string): Promise<SnapshotSchema.FileVersion> => {
          const entry = entries.get(objectSizeKey(tree, filename))
          if (!entry) return { kind: "missing", version: "missing", bytes: 0 }
          const base = { version: entry.oid, bytes: entry.size }
          if (entry.mode === "120000") return { ...base, kind: "symlink" }
          if (entry.size > 1024 * 1024) return { ...base, kind: "oversized" }
          const result = await gitSpawn(
            ["git", "--git-dir", git, "cat-file", "blob", entry.oid],
            path.dirname(git),
            undefined,
            signal,
          )
          if (result.exitCode !== 0 || result.bytes.length !== entry.size)
            throw new SnapshotStore.StorageError("Snapshot file content is unavailable")
          try {
            if (result.bytes.includes(0)) throw new Error("binary")
            return { ...base, kind: "text", content: new TextDecoder("utf-8", { fatal: true }).decode(result.bytes) }
          } catch {
            return { ...base, kind: "binary", base64: Buffer.from(result.bytes).toString("base64") }
          }
        }
        const [before, after] = await Promise.all([read(from), read(to)])
        return { before, after }
      },
      signal,
      { historical: true },
    )
  }

  export async function revert(
    patches: Patch[],
    sessionID: string,
    signal?: AbortSignal,
    preview?: Pick<SnapshotRestore.PreviewFile, "file" | "workspace" | "version">[],
  ): Promise<SnapshotRestore.Result> {
    return withRestoreFiles(patches, sessionID, signal, (files) => {
      for (const file of files) {
        if (!preview) continue
        const expected = preview.find(
          (row) =>
            row.file === file.file &&
            row.workspace.id === file.workspace.id &&
            row.workspace.generation === file.workspace.generation,
        )
        if (!expected) throw new SnapshotRestore.Invalid({ message: "A selected file has no confirmed preview" })
        file.expected = expected.version
      }
      return SnapshotRestore.apply({ files, signal })
    })
  }

  async function withRestoreFiles<T>(
    patches: Patch[],
    sessionID: string,
    signal: AbortSignal | undefined,
    action: (files: SnapshotRestore.File[]) => Promise<T>,
  ): Promise<T> {
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
          if (source.pathKind === "workspace") {
            const info = await WorkspaceCatalog.get(source.id, ScopeContext.current.scope.id)
            if (
              info.binding.generation !== source.generation ||
              info.binding.state !== "bound" ||
              info.lifecycle !== "active"
            )
              throw new SnapshotRestore.Invalid({ message: "The historical Workspace binding is unavailable" })
          } else {
            const binding = await WorkspaceBinding.validate(source.id, ScopeContext.current.scope.id, source.generation)
            if (binding.path !== source.root)
              throw new SnapshotRestore.Invalid({
                message: "The historical Workspace location does not match its binding",
              })
          }
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
            const relative = source.pathKind === "workspace" ? file : path.relative(source.root, file)
            if (
              (source.pathKind !== "workspace" && !path.isAbsolute(file)) ||
              !relative ||
              relative === ".." ||
              relative.startsWith(`..${path.sep}`) ||
              path.isAbsolute(relative)
            )
              throw new SnapshotRestore.Invalid({ message: "A historical file is outside its Workspace" })
            const normalized =
              source.pathKind === "workspace" ? WorkspaceTree.Path.parse(relative) : path.normalize(file)
            const identity = JSON.stringify([source.id, source.generation, normalized])
            if (files.has(identity)) continue
            const entry = tree.get(process.platform === "win32" ? relative.replaceAll("\\", "/") : relative)
            if (entry && !["100644", "100755", "120000"].includes(entry.mode))
              throw new SnapshotRestore.Invalid({ message: "This snapshot file mode cannot be restored" })
            files.set(identity, {
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
        return action([...files.values()])
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
    file?: string,
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
        "--literal-pathspecs",
        "diff",
        "--no-ext-diff",
        "--no-renames",
        "--numstat",
        "-p",
        "-z",
        from,
        to,
        "--",
        file ?? ".",
      ],
      path.dirname(git),
      undefined,
      signal,
    )
    if (diff.exitCode !== 0) {
      log.warn("failed to get diff summary", { from, to, exitCode: diff.exitCode, stderr: diff.stderr })
      throw new SnapshotStore.StorageError("Snapshot comparison failed")
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
    return file ? result : SnapshotSchema.boundArray(result)
  }

  async function refreshIndex(
    sessionID: string,
    signal?: AbortSignal,
    onOmissions?: (omissions: SnapshotSchema.Omission[]) => void,
  ): Promise<boolean> {
    try {
      return await SnapshotCapture.refresh(SnapshotStore.current(), signal, undefined, onOmissions)
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
