import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { lstatSync, readFileSync, readlinkSync, realpathSync, statSync } from "node:fs"
import path from "node:path"
import { analyzeSource, type SourceFacts } from "./source-analysis"
import { decodeRevisionInventory, type RevisionEntry } from "./ci/revision"
import { matchesExempt, type Exemption, type LcovRecord } from "./coverage-check"

export class WorkingSnapshot {
  readonly inventory = new Map<string, RevisionEntry>()
  readonly files: string[]
  readonly sources = new Map<string, string>()
  readonly digest: string
  private readonly analyses = new Map<string, SourceFacts>()

  constructor(root: string) {
    const candidates = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
      cwd: root,
      maxBuffer: 128 * 1024 * 1024,
    })
      .toString()
      .split("\0")
      .filter(Boolean)
    const digest = createHash("sha256")
    for (const file of [...new Set(candidates)].sort()) {
      const absolute = path.join(root, file)
      const stat = lstatSync(absolute, { throwIfNoEntry: false })
      if (!stat) continue
      if (!stat.isFile() && !stat.isSymbolicLink()) throw new Error(`Unsupported verification input: ${file}`)
      const bytes = stat.isSymbolicLink() ? Buffer.from(readlinkSync(absolute)) : readFileSync(absolute)
      const mode = stat.isSymbolicLink() ? "120000" : stat.mode & 0o111 ? "100755" : "100644"
      const oid = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex")
      this.inventory.set(file, { path: file, mode, oid, type: "blob" })
      this.sources.set(file, bytes.toString())
      digest.update(JSON.stringify([file, mode, oid]))
    }
    this.files = [...this.inventory.keys()]
    this.digest = digest.digest("hex")
  }

  read(file: string) {
    return this.sources.get(file)
  }
  required(file: string) {
    const source = this.read(file)
    if (source === undefined) throw new Error(`Missing verification input: ${file}`)
    return source
  }
  facts(file: string) {
    const previous = this.analyses.get(file)
    if (previous) return previous
    const facts = analyzeSource(file, this.required(file))
    this.analyses.set(file, facts)
    return facts
  }
}

export function changedInputs(root: string, base: string, snapshot: WorkingSnapshot) {
  const before = decodeRevisionInventory(
    base,
    execFileSync("git", ["ls-tree", "-rz", base], {
      cwd: root,
      maxBuffer: 128 * 1024 * 1024,
    }),
  )
  return [...new Set([...before.keys(), ...snapshot.files])]
    .filter((file) => {
      const left = before.get(file),
        right = snapshot.inventory.get(file)
      return left?.oid !== right?.oid || left?.mode !== right?.mode
    })
    .sort()
}

export function verificationToolchain(root: string, env: NodeJS.ProcessEnv = process.env) {
  return JSON.stringify({
    bun: Bun.version,
    executable: realpathSync(process.execPath),
    platform: process.platform,
    arch: process.arch,
    tools: ["bun", "node", "git", "rg", "sh"].map((name) => {
      const located = Bun.which(name, { PATH: env.PATH, cwd: root })
      if (!located) return [name, null]
      const executable = realpathSync(located)
      const stat = statSync(executable)
      return [name, executable, stat.size, stat.mtimeMs]
    }),
    environment: [env.CI, env.NODE_ENV, env.NODE_OPTIONS, env.BUN_OPTIONS],
  })
}

export function missingMeasurements(files: string[], records: LcovRecord[], exemptions: Exemption[]) {
  const measured = new Set(records.map((record) => record.file))
  return files.filter((file) => !matchesExempt(file, exemptions) && !measured.has(file))
}
