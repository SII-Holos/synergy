import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { lstatSync, readFileSync, readlinkSync } from "node:fs"
import { rename } from "node:fs/promises"
import path from "node:path"
import { analyzeSource, type SourceFacts } from "./source-analysis"
import { decodeRevisionInventory, type RevisionEntry } from "./ci/revision"
import { matchesExempt, type Exemption, type LcovRecord } from "./coverage-check"
import type { Gate, GateError } from "./gates"

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

const REUSABLE = new Set(["format:check", "lint", "typecheck", "monorepo:check", "doc:check", "decision:check"])
type Receipt = { version: 1; input: string; gates: Record<string, { command: string; completed: number }> }

export async function cachedChecks(
  root: string,
  gates: Gate[],
  execute: (gate: Gate) => Promise<GateError | null>,
  toolchain = JSON.stringify([
    Bun.version,
    process.execPath,
    process.platform,
    process.arch,
    process.env.PATH,
    process.env.CI,
    process.env.NODE_ENV,
  ]),
) {
  const snapshot = new WorkingSnapshot(root)
  const input = createHash("sha256").update(snapshot.digest).update(toolchain).digest("hex")
  const file = path.join(root, ".artifacts/verify/checks.json")
  const previous = (await Bun.file(file)
    .json()
    .catch(() => undefined)) as Receipt | undefined
  const saved =
    previous?.version === 1 && previous.input === input && previous.gates && typeof previous.gates === "object"
      ? previous.gates
      : {}
  const reused = gates
    .filter((gate) => {
      const receipt = saved[gate.id]
      return (
        REUSABLE.has(gate.id) &&
        receipt?.command === gate.run &&
        Number.isFinite(receipt.completed) &&
        receipt.completed <= Date.now() &&
        Date.now() - receipt.completed < 24 * 60 * 60 * 1000
      )
    })
    .map((gate) => gate.id)
  const { runGateSet } = await import("./gates")
  const result = await runGateSet(gates, root, async (gate) => (reused.includes(gate.id) ? null : execute(gate)))
  if (new WorkingSnapshot(root).digest !== snapshot.digest) {
    result.failures.push({
      gate: "inputs-changed",
      exitCode: 1,
      stderr: "Verification inputs changed during checks; run again.",
    })
    await Bun.write(file, "{}\n")
    return { ...result, reused }
  }
  const receipts = { ...saved }
  for (const gate of gates) {
    delete receipts[gate.id]
    if (REUSABLE.has(gate.id) && !result.failures.some((failure) => failure.gate === gate.id))
      receipts[gate.id] = { command: gate.run, completed: Date.now() }
  }
  const temporary = `${file}.${crypto.randomUUID()}.tmp`
  await Bun.write(temporary, JSON.stringify({ version: 1, input, gates: receipts } satisfies Receipt))
  await rename(temporary, file)
  return { ...result, reused }
}

export function missingMeasurements(files: string[], records: LcovRecord[], exemptions: Exemption[]) {
  const measured = new Set(records.map((record) => record.file))
  return files.filter((file) => !matchesExempt(file, exemptions) && !measured.has(file))
}
