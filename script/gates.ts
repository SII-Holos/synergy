#!/usr/bin/env bun

/**
 * Gate orchestrator. Runs the static gate cluster as a dependency-ordered,
 * concurrency-bounded graph so local and CI execute the same commands.
 *
 * Modes:
 *   bun script/gates.ts local        the local static cluster (quality:quick)
 *   bun script/gates.ts ci-static    same cluster minus workflow/secrets
 *                                    (those run as dedicated CI jobs)
 *
 * Concurrency is bounded by SYNERGY_GATE_CONCURRENCY (default 4).
 */

import path from "node:path"
import { $ } from "bun"

const REPO_ROOT = path.resolve(import.meta.dir, "..")

export interface Gate {
  id: string
  run: string
  needs: string[]
}

const LOCAL_GATES: Gate[] = [
  { id: "format:check", run: "bun run format:check", needs: [] },
  { id: "lint", run: "bun run lint", needs: [] },
  { id: "skill:check", run: "bun run skill:check", needs: [] },
  { id: "package-guide:check", run: "bun run package-guide:check", needs: [] },
  { id: "test-layout:check", run: "bun run test-layout:check", needs: [] },
  { id: "localization:check", run: "bun run localization:check", needs: [] },
  { id: "typecheck", run: "bun run typecheck", needs: [] },
  { id: "monorepo:check", run: "bun run monorepo:check", needs: [] },
  { id: "package:check", run: "bun run package:check", needs: [] },
  { id: "brand:gen:check", run: "bun run brand:gen:check", needs: [] },
  { id: "doc:check", run: "bun run doc:check", needs: [] },
  { id: "decision:check", run: "bun run decision:check", needs: [] },
  { id: "deadcode", run: "bun run deadcode", needs: [] },
  {
    id: "browser-crypto:check",
    run: "bun test --cwd packages/app test/testing/browser-crypto-contract.test.ts",
    needs: [],
  },
  { id: "coverage:check", run: "bun run coverage:check", needs: [] },
  { id: "secrets:check", run: "bun run secrets:check", needs: [] },
  { id: "workflow:check", run: "bun run workflow:check", needs: [] },
]

const ALL_GATE_IDS = LOCAL_GATES.map((gate) => gate.id)

const MODES: Record<string, { include: string[]; exclude: string[] }> = {
  local: { include: ALL_GATE_IDS, exclude: ["browser-crypto:check", "coverage:check"] },
  "ci-static": {
    include: ALL_GATE_IDS,
    exclude: ["coverage:check", "secrets:check", "workflow:check"],
  },
  "ci-coverage": { include: ["coverage:check"], exclude: [] },
}

export interface GateError {
  gate: string
  exitCode: number
  stderr: string
}

export interface GateRunResult {
  gates: string[]
  failures: GateError[]
}

export function gatesForMode(mode: string): Gate[] {
  const config = MODES[mode]
  if (!config) throw new Error(`unknown gate mode '${mode}' (available: ${Object.keys(MODES).join(", ")})`)
  return LOCAL_GATES.filter((gate) => config.include.includes(gate.id) && !config.exclude.includes(gate.id))
}

export function detectCycles(gates: Gate[]): string[] {
  const byId = new Map(gates.map((gate) => [gate.id, gate]))
  const state = new Map<string, "visiting" | "done">()
  const cycles: string[] = []
  const visit = (id: string, stack: string[]) => {
    const current = state.get(id)
    if (current === "done") return
    if (current === "visiting") {
      const start = stack.indexOf(id)
      cycles.push([...stack.slice(start), id].join(" -> "))
      return
    }
    state.set(id, "visiting")
    for (const dep of byId.get(id)?.needs ?? []) {
      if (!byId.has(dep)) continue
      visit(dep, [...stack, id])
    }
    state.set(id, "done")
  }
  for (const gate of gates) visit(gate.id, [])
  return cycles
}

export function concurrencyLimit(): number {
  const raw = process.env.SYNERGY_GATE_CONCURRENCY
  const parsed = raw ? Number(raw) : 4
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 4
}

async function runGate(gate: Gate, root: string): Promise<GateError | null> {
  const output = await $`sh -c ${gate.run}`.cwd(root).nothrow().quiet()
  if (output.exitCode === 0) return null
  // Keep the full failure detail: coverage gates print per-file uncovered
  // lines that a 1000-char slice truncates to the alphabetically last file,
  // hiding the real gap list. Include stdout too — coverage-check's per-package
  // verdict lines go there and are otherwise invisible. Cap only to avoid
  // pathological logs.
  const stderr = output.stderr.toString()
  const stdout = output.stdout.toString()
  const detail = stdout ? `${stderr}\n--- stdout ---\n${stdout}` : stderr
  return { gate: gate.id, exitCode: output.exitCode, stderr: detail.slice(0, 100_000) }
}

export function validateGateGraph(gates: Gate[]): string[] {
  const errors: string[] = []
  for (const cycle of detectCycles(gates)) errors.push(`cycle: ${cycle}`)
  const ids = new Set(gates.map((gate) => gate.id))
  const unknownNeeds = gates.flatMap((gate) => gate.needs).filter((need) => !ids.has(need))
  for (const need of new Set(unknownNeeds)) errors.push(`unknown dependency: ${need}`)
  for (let index = 0; index < gates.length; index++) {
    if (gates.findIndex((other) => other.id === gates[index]!.id) !== index) {
      errors.push(`duplicate gate id: ${gates[index]!.id}`)
    }
  }
  return [...new Set(errors)]
}

export async function runGateSet(
  gates: Gate[],
  root: string = REPO_ROOT,
  execute: (gate: Gate) => Promise<GateError | null> = (gate) => runGate(gate, root),
): Promise<GateRunResult> {
  const errors = validateGateGraph(gates)
  if (errors.length > 0) {
    throw new Error(`invalid gate graph: ${errors.join("; ")}`)
  }

  const results = new Map<string, GateError | null>()
  const limit = concurrencyLimit()
  const pending = new Set(gates.map((gate) => gate.id))
  let running = 0

  await new Promise<void>((resolve, reject) => {
    const pump = () => {
      while (running < limit) {
        const ready = gates.find((gate) => pending.has(gate.id) && gate.needs.every((need) => !pending.has(need)))
        if (!ready) break
        pending.delete(ready.id)
        running++
        execute(ready)
          .then((result) => {
            results.set(ready.id, result)
            running--
            pump()
          })
          .catch((error) => reject(error))
      }
      if (running === 0 && pending.size === 0) resolve()
    }
    pump()
  })

  const failures = gates.filter((gate) => results.get(gate.id)).map((gate) => results.get(gate.id)!)
  return { gates: gates.map((gate) => gate.id), failures }
}

export async function runGates(mode: string, root: string = REPO_ROOT): Promise<GateRunResult> {
  return runGateSet(gatesForMode(mode), root)
}

if (import.meta.main) {
  const mode = process.argv[2]
  if (!mode) {
    console.error(`usage: bun script/gates.ts <mode> (modes: ${Object.keys(MODES).join(", ")})`)
    process.exit(2)
  }
  const result = await runGates(mode)
  for (const gate of result.gates) {
    const failed = result.failures.some((failure) => failure.gate === gate)
    console.log(`${failed ? "FAIL" : "PASS"} ${gate}`)
  }
  if (result.failures.length > 0) {
    for (const failure of result.failures) {
      console.error(`\n${failure.gate} (exit ${failure.exitCode}):\n${failure.stderr}`)
    }
    console.error(`\nGate run failed: ${result.failures.length} of ${result.gates.length} gates failed.`)
    process.exit(1)
  }
  console.log(`\nAll ${result.gates.length} gates passed.`)
}
