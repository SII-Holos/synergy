import { createHash } from "node:crypto"
import path from "node:path"
import { ReviewSchema as R } from "./schema"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { WorkspaceBinding } from "@ericsanchezok/synergy-harness/workspace"
import { SnapshotSchema } from "@ericsanchezok/synergy-harness/session/snapshot-schema"
import { FileView } from "@ericsanchezok/synergy-local-runtime/file/view"
import { WorktreeProcess } from "@ericsanchezok/synergy-local-runtime/workspace/process"

export namespace ReviewGit {
  const maxBytes = 768 * 1024
  const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex")
  async function validate(input: R.CompareInput) {
    const workspace = ScopeContext.current.workspace
    if (!workspace || workspace.id !== input.workspaceID || workspace.generation !== input.generation)
      throw new R.Conflict({ message: "The selected workspace changed. Refresh the comparison." })
    await WorkspaceBinding.validate(input.workspaceID, ScopeContext.current.scope.id, input.generation)
    if (!FileView.native()) throw new R.Invalid({ message: "Git comparison requires an active native workspace." })
    return { id: input.workspaceID, generation: input.generation, root: workspace.path }
  }
  async function git(args: string[], signal?: AbortSignal, diff = false) {
    const result = await WorktreeProcess.run({
      command: ["git", "-c", "core.quotepath=false", "-c", "core.fsmonitor=false", "--literal-pathspecs", ...args],
      directory: FileView.directory(),
      roots: [],
      metadata: true,
      env: { GIT_OPTIONAL_LOCKS: "0", GIT_NO_REPLACE_OBJECTS: "1", GIT_TERMINAL_PROMPT: "0" },
      signal: AbortSignal.any([AbortSignal.timeout(30_000), ...(signal ? [signal] : [])]),
    })
    if (result.exitCode !== 0 && !(diff && result.exitCode === 1))
      throw new R.Invalid({ message: result.stderr.toString().trim() || "The repository could not be read." })
    return result.stdout
  }
  async function ref(value: string, signal?: AbortSignal) {
    if (value.startsWith("-") || /[\0\r\n]/.test(value))
      throw new R.Invalid({ message: "Invalid comparison reference." })
    return (await git(["rev-parse", "--verify", "--end-of-options", `${value}^{commit}`], signal)).toString().trim()
  }
  async function endpoints(input: R.CompareInput, signal?: AbortSignal) {
    if (input.source === "branch") {
      const [from, to] = await Promise.all([ref(input.from ?? "origin/dev", signal), ref(input.to ?? "HEAD", signal)])
      return { from, to }
    }
    const from = await ref("HEAD", signal).catch((error) => {
      if (signal?.aborted) throw error
      return ""
    })
    return { from, to: "worktree" }
  }
  async function currentVersion(file: string) {
    const stat = await FileView.stat(file)
    return stat?.entryVersion ?? "missing"
  }
  async function fileVersion(input: R.CompareInput, endpoint: { from: string; to: string }, file: string) {
    return hash(
      JSON.stringify([
        input.workspaceID,
        input.generation,
        endpoint.from,
        endpoint.to,
        file,
        input.source === "worktree" ? await currentVersion(file) : "",
      ]),
    )
  }
  export async function compare(raw: R.CompareInput, signal?: AbortSignal) {
    const input = R.CompareInput.parse(raw)
    const workspace = await validate(input)
    const endpoint = await endpoints(input, signal)
    const args = ["diff", "--no-ext-diff", "--no-textconv", "--no-renames"]
    const references = [endpoint.from, ...(input.source === "branch" ? [endpoint.to] : []), "--", "."]
    const [stats, names] = endpoint.from
      ? await Promise.all([
          git([...args, "--numstat", "-z", ...references], signal).then((bytes) => bytes.toString()),
          git([...args, "--name-status", "-z", ...references], signal).then((bytes) => bytes.toString().split("\0")),
        ])
      : ["", []]
    const statuses = new Map<string, string>()
    for (let index = 0; index + 1 < names.length; index += 2) statuses.set(names[index + 1]!, names[index]!)
    const files: R.File[] = stats
      .split("\0")
      .filter(Boolean)
      .map((record) => {
        const first = record.indexOf("\t"),
          second = record.indexOf("\t", first + 1)
        const additions = record.slice(0, first),
          deletions = record.slice(first + 1, second)
        return {
          file: record.slice(second + 1),
          additions: Number(additions) || 0,
          deletions: Number(deletions) || 0,
          binary: additions === "-",
          workspace,
          status:
            statuses.get(record.slice(second + 1)) === "D"
              ? "deleted"
              : statuses.get(record.slice(second + 1)) === "A"
                ? "added"
                : "modified",
          version: "",
        }
      })
    if (input.source === "worktree") {
      const untracked = (
        await git(["ls-files", "--others", "--exclude-standard", "-z", ...(!endpoint.from ? ["--cached"] : [])], signal)
      )
        .toString()
        .split("\0")
        .filter(Boolean)
      if (new Set([...files.map((file) => file.file), ...untracked]).size > 5000)
        throw new R.Invalid({ message: "The comparison exceeds the 5,000 file limit. Narrow the comparison." })
      for (const filename of new Set(untracked)) {
        signal?.throwIfAborted()
        if (files.some((file) => file.file === filename)) continue
        const after = await readCurrent(filename, signal)
        if (after.kind === "missing") continue
        files.push({
          file: filename,
          additions:
            after.kind === "text"
              ? (after.content?.match(/\n/g)?.length ?? 0) + (after.content && !after.content.endsWith("\n") ? 1 : 0)
              : 0,
          deletions: 0,
          binary: after.kind !== "text",
          workspace,
          status: "added",
          version: "",
        })
      }
    }
    if (files.length > 5000)
      throw new R.Invalid({ message: "The comparison exceeds the 5,000 file limit. Narrow the comparison." })
    for (let offset = 0; offset < files.length; offset += 16)
      await Promise.all(
        files.slice(offset, offset + 16).map(async (file) => {
          file.version = await fileVersion(input, endpoint, file.file)
        }),
      )
    await validate(input)
    return { source: input.source, ...endpoint, files: files.sort((a, b) => a.file.localeCompare(b.file)) }
  }
  const missing: SnapshotSchema.FileVersion = { kind: "missing", version: "missing", bytes: 0 }
  function decode(bytes: Buffer, version = hash(bytes)): SnapshotSchema.FileVersion {
    const base = { version, bytes: bytes.length }
    try {
      if (bytes.includes(0)) throw new Error("binary")
      return { ...base, kind: "text", content: new TextDecoder("utf-8", { fatal: true }).decode(bytes) }
    } catch {
      return { ...base, kind: "binary", base64: bytes.toString("base64") }
    }
  }
  async function readCurrent(file: string, signal?: AbortSignal): Promise<SnapshotSchema.FileVersion> {
    signal?.throwIfAborted()
    const stat = await FileView.stat(file)
    if (!stat) return missing
    if (stat.kind !== "file") return { kind: "symlink", version: stat.entryVersion, bytes: stat.size }
    if (stat.size > maxBytes) return { kind: "oversized", version: stat.entryVersion, bytes: stat.size }
    const canonical = await FileView.canonical(file)
    const relative = path.relative(await FileView.canonical("."), canonical)
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
      throw new R.Invalid({ message: "The file resolves outside the workspace." })
    const bytes = await FileView.bytes(file, undefined, maxBytes)
    signal?.throwIfAborted()
    if ((await FileView.stat(file))?.entryVersion !== stat.entryVersion)
      throw new R.Conflict({ message: "The file changed while it was read." })
    return decode(Buffer.from(bytes))
  }
  async function readObject(tree: string, file: string, signal?: AbortSignal): Promise<SnapshotSchema.FileVersion> {
    if (!tree) return missing
    const listing = (await git(["ls-tree", "-l", "-z", tree, "--", file], signal)).toString()
    if (!listing) return missing
    const [mode, , oid, size] = listing.slice(0, listing.indexOf("\t")).trim().split(/\s+/)
    const base = { version: oid!, bytes: Number(size) || 0 }
    if (mode === "120000" || mode === "160000") return { ...base, kind: "symlink" }
    if (Number(size) > maxBytes) return { ...base, kind: "oversized" }
    return decode(await git(["cat-file", "blob", oid!], signal), oid)
  }
  export async function file(raw: import("zod").z.infer<typeof R.FileInput>, signal?: AbortSignal) {
    const input = R.FileInput.parse(raw)
    const workspace = await validate(input)
    const endpoint = await endpoints(input, signal)
    if ((await fileVersion(input, endpoint, input.file)) !== input.version)
      throw new R.Conflict({ message: "This comparison changed. Refresh before continuing." })
    const [before, after] = await Promise.all([
      readObject(endpoint.from, input.file, signal),
      input.source === "worktree" ? readCurrent(input.file, signal) : readObject(endpoint.to, input.file, signal),
    ])
    const oversized = before.kind === "oversized" || after.kind === "oversized"
    const added = before.kind === "missing" && input.source === "worktree"
    const args = added
      ? ["diff", "--no-index", "--binary", "--no-ext-diff", "--no-textconv", "--", "/dev/null", input.file]
      : [
          "diff",
          "--binary",
          "--no-ext-diff",
          "--no-textconv",
          "--no-renames",
          endpoint.from,
          ...(input.source === "branch" ? [endpoint.to] : []),
          "--",
          input.file,
        ]
    const patch = oversized ? "" : (await git(args, signal, added)).toString()
    const lines = patch.split("\n")
    const diff = {
      file: input.file,
      workspace,
      patch,
      preview: patch,
      binary: before.kind === "binary" || after.kind === "binary",
      additions: lines.filter((line) => line.startsWith("+") && !line.startsWith("+++")).length,
      deletions: lines.filter((line) => line.startsWith("-") && !line.startsWith("---")).length,
      beforeBytes: before.bytes,
      afterBytes: after.bytes,
    }
    if ((await fileVersion(input, endpoint, input.file)) !== input.version)
      throw new R.Conflict({ message: "This comparison changed while it was read." })
    await validate(input)
    return { before, after, diff, version: input.version }
  }
}
