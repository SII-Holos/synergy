import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { analyzeSource, type SourceFacts } from "../source-analysis"

export type RevisionEntry = { mode: string; type: "blob" | "commit"; oid: string; path: string }
type RevisionStage = "revision" | "inventory" | "batch" | "read"

export class RevisionInputError extends Error {
  constructor(
    readonly revision: string,
    readonly stage: RevisionStage,
    readonly reason: string,
    readonly path?: string,
    options?: ErrorOptions,
  ) {
    super(`Invalid CI revision input ${revision} (${stage}${path ? `: ${path}` : ""}): ${reason}`, options)
    this.name = "RevisionInputError"
  }
}

export function decodeRevisionInventory(revision: string, output: Buffer): Map<string, RevisionEntry> {
  const inventory = new Map<string, RevisionEntry>()
  let offset = 0
  while (offset < output.length) {
    const end = output.indexOf(0, offset)
    if (end < 0) throw new RevisionInputError(revision, "inventory", "unterminated record")
    const record = output.subarray(offset, end)
    const separator = record.indexOf(9)
    const header = record.subarray(0, separator).toString()
    const match = /^(100644|100755|120000|160000) (blob|commit) ([a-f0-9]{40})$/.exec(header)
    const file = record.subarray(separator + 1).toString()
    if (separator < 0 || !match || (match[1] === "160000" ? match[2] !== "commit" : match[2] !== "blob"))
      throw new RevisionInputError(revision, "inventory", "invalid mode, type or OID")
    if (
      !file ||
      file.split("/").some((part) => !part || part === "." || part === "..") ||
      !Buffer.from(file).equals(record.subarray(separator + 1)) ||
      inventory.has(file)
    )
      throw new RevisionInputError(revision, "inventory", "invalid or duplicate path", file)
    inventory.set(file, { mode: match[1]!, type: match[2] as RevisionEntry["type"], oid: match[3]!, path: file })
    offset = end + 1
  }
  return inventory
}

export function decodeRevisionBlobs(revision: string, entries: RevisionEntry[], output: Buffer): Map<string, string> {
  const sources = new Map<string, string>()
  let offset = 0
  for (const entry of entries) {
    const end = output.indexOf(10, offset)
    if (end < 0) throw new RevisionInputError(revision, "batch", "missing object header", entry.path)
    const match = /^([a-f0-9]{40}) blob (0|[1-9][0-9]*)$/.exec(output.subarray(offset, end).toString())
    if (!match || match[1] !== entry.oid)
      throw new RevisionInputError(revision, "batch", "unexpected OID, type or size", entry.path)
    const size = Number(match[2])
    offset = end + 1
    if (!Number.isSafeInteger(size) || size > output.length - offset - 1)
      throw new RevisionInputError(revision, "batch", "unsafe size or truncated body", entry.path)
    const body = output.subarray(offset, offset + size)
    if (output[offset + size] !== 10)
      throw new RevisionInputError(revision, "batch", "missing object trailer", entry.path)
    const oid = createHash("sha1").update(`blob ${size}\0`).update(body).digest("hex")
    if (oid !== entry.oid) throw new RevisionInputError(revision, "batch", "blob hash mismatch", entry.path)
    sources.set(entry.path, body.toString())
    offset += size + 1
  }
  if (offset !== output.length) throw new RevisionInputError(revision, "batch", "unexpected trailing bytes")
  return sources
}

export class RevisionSnapshot {
  readonly inventory: Map<string, RevisionEntry>
  readonly files: string[]
  readonly sources: Map<string, string>
  private readonly analyses = new Map<string, SourceFacts>()

  constructor(
    root: string,
    readonly revision: string,
  ) {
    if (!/^[a-f0-9]{40}$/.test(revision)) throw new RevisionInputError(revision, "revision", "expected full commit SHA")
    const git = (stage: "inventory" | "batch", args: string[], input?: string): Buffer => {
      try {
        return execFileSync("git", args, {
          cwd: root,
          input,
          maxBuffer: 128 * 1024 * 1024,
          stdio: ["pipe", "pipe", "pipe"],
        })
      } catch (cause) {
        throw new RevisionInputError(revision, stage, "Git read failed", undefined, { cause })
      }
    }
    const inventory = decodeRevisionInventory(revision, git("inventory", ["ls-tree", "-rz", revision]))
    const files = [...inventory.values()].filter((entry) => entry.type === "blob")
    const entries = files.filter(
      (entry) =>
        /\.[cm]?[jt]sx?$/.test(entry.path) ||
        /(?:^|\/)(?:package|tsconfig[^/]*)\.json$/.test(entry.path) ||
        entry.path === "script/coverage-exempt.json",
    )
    const sources = decodeRevisionBlobs(
      revision,
      entries,
      git("batch", ["cat-file", "--batch"], entries.map((entry) => `${entry.oid}\n`).join("")),
    )
    this.inventory = inventory
    this.files = files.map((entry) => entry.path)
    this.sources = sources
  }

  read(file: string): string | undefined {
    if (this.inventory.get(file)?.type !== "blob") return undefined
    const source = this.sources.get(file)
    if (source === undefined)
      throw new RevisionInputError(this.revision, "read", "requested input was not admitted", file)
    return source
  }

  required(file: string): string {
    const source = this.read(file)
    if (source === undefined) throw new RevisionInputError(this.revision, "read", "required input is absent", file)
    return source
  }

  facts(file: string): SourceFacts {
    const existing = this.analyses.get(file)
    if (existing) return existing
    const facts = analyzeSource(file, this.required(file))
    this.analyses.set(file, facts)
    return facts
  }
}
