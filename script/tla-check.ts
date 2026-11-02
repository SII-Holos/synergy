#!/usr/bin/env bun

/**
 * Structural gate for the TLA+ pilot.
 *
 *   bun script/tla-check.ts
 *   SYNERGY_TLC=1 TLA2TOOLS_JAR=/path/to/tla2tools.jar bun script/tla-check.ts
 *
 * The default mode does not download or run TLC. `--tlc` / SYNERGY_TLC=1
 * model-checks the two passing specs. MessageWindow.candidate.cfg is a known
 * violation and is not executed here.
 */

import { spawnSync } from "node:child_process"
import { readFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const REPO_ROOT = path.resolve(import.meta.dir, "..")
const TLA_DIR = path.join("spec", "tla")

const MODULES = ["ScopeEpochReplay", "MessageWindow"] as const

const REQUIRED_INVARIANTS: Record<(typeof MODULES)[number], readonly string[]> = {
  ScopeEpochReplay: [
    "TypeOK",
    "InvJournal",
    "InvSameEpochNotAhead",
    "InvHoldFreezesWatermark",
    "InvWatermarkStep",
    "InvRecoverKind",
    "InvOkCovered",
    "InvResetJustified",
  ],
  MessageWindow: [
    "TypeOK",
    "InvPendingFlag",
    "InvPendingDisjoint",
    "InvCap",
    "InvSubset",
    "InvTailOnlyInHistory",
    "InvLatestClean",
    "InvUnloaded",
    "InvCursorOnlyHistory",
    "InvLatestPageIsSuffix",
    "InvPrependDropsNewest",
    "InvPendingStep",
    "InvHistoryTouchPreserves",
    "InvRemovePreserves",
    "InvIgnoreUnloaded",
  ],
}

const REQUIRED_PROPERTIES: Record<(typeof MODULES)[number], readonly string[]> = {
  ScopeEpochReplay: ["CaughtUp"],
  MessageWindow: [],
}

const README_MARKERS = [
  "tla2tools.jar",
  "tlc2.TLC",
  "ScopeEpochReplay",
  "MessageWindow",
  "CandidatePendingIsNewer",
  "SYNERGY_TLC",
]

export interface CfgFile {
  specification?: string
  invariants: string[]
  properties: string[]
  constants: string[]
}

export function parseCfg(text: string): CfgFile {
  const cfg: CfgFile = { invariants: [], properties: [], constants: [] }
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\\\*.*$/, "").trim()
    if (!line) continue
    const specification = line.match(/^SPECIFICATION\s+([A-Za-z][A-Za-z0-9]*)\s*$/)
    if (specification) {
      cfg.specification = specification[1]
      continue
    }
    const invariant = line.match(/^INVARIANT\s+([A-Za-z][A-Za-z0-9]*)\s*$/)
    if (invariant) {
      cfg.invariants.push(invariant[1]!)
      continue
    }
    const property = line.match(/^PROPERTY\s+([A-Za-z][A-Za-z0-9]*)\s*$/)
    if (property) {
      cfg.properties.push(property[1]!)
      continue
    }
    const constant = line.match(/^CONSTANT\s+([A-Za-z][A-Za-z0-9]*)\s*=/)
    if (constant) cfg.constants.push(constant[1]!)
  }
  return cfg
}

export function definedOperators(text: string): Set<string> {
  const names = new Set<string>()
  for (const line of text.split("\n")) {
    const match = line.match(/^([A-Za-z][A-Za-z0-9]*)\s*==/)
    if (match) names.add(match[1]!)
  }
  return names
}

export function auditModule(input: {
  name: (typeof MODULES)[number]
  tla: string
  cfgText: string
}): string[] {
  const errors: string[] = []
  const cfg = parseCfg(input.cfgText)
  const defined = definedOperators(input.tla)
  const label = `${input.name}.cfg`
  if (!cfg.specification) errors.push(`${label}: missing SPECIFICATION`)
  else if (!defined.has(cfg.specification)) {
    errors.push(`${label}: SPECIFICATION ${cfg.specification} is not defined in ${input.name}.tla`)
  }
  for (const name of [...cfg.invariants, ...cfg.properties]) {
    if (!defined.has(name)) errors.push(`${label}: ${name} is not defined in ${input.name}.tla`)
  }
  for (const name of REQUIRED_INVARIANTS[input.name]) {
    if (!cfg.invariants.includes(name)) errors.push(`${label}: missing INVARIANT ${name}`)
  }
  for (const name of REQUIRED_PROPERTIES[input.name]) {
    if (!cfg.properties.includes(name)) errors.push(`${label}: missing PROPERTY ${name}`)
  }
  if (input.name === "MessageWindow" && cfg.invariants.includes("CandidatePendingIsNewer")) {
    errors.push(`${label}: CandidatePendingIsNewer is a known violation and is not a checked invariant`)
  }
  return errors
}

export async function checkTlaSpecs(root: string): Promise<string[]> {
  const errors: string[] = []
  const dir = path.join(root, TLA_DIR)
  const readmePath = path.join(dir, "README.md")
  const readme = await readFile(readmePath, "utf8").catch(() => null)
  if (readme === null) errors.push(`${TLA_DIR}/README.md: missing`)
  else {
    for (const marker of README_MARKERS) {
      if (!readme.includes(marker)) errors.push(`${TLA_DIR}/README.md: must mention ${marker}`)
    }
  }

  for (const name of MODULES) {
    const tlaPath = path.join(dir, `${name}.tla`)
    const cfgPath = path.join(dir, `${name}.cfg`)
    const tla = await readFile(tlaPath, "utf8").catch(() => null)
    const cfgText = await readFile(cfgPath, "utf8").catch(() => null)
    if (tla === null) errors.push(`${TLA_DIR}/${name}.tla: missing`)
    if (cfgText === null) errors.push(`${TLA_DIR}/${name}.cfg: missing`)
    if (tla === null || cfgText === null) continue
    errors.push(...auditModule({ name, tla, cfgText }))
  }

  const candidatePath = path.join(dir, "MessageWindow.candidate.cfg")
  const candidate = await readFile(candidatePath, "utf8").catch(() => null)
  if (candidate === null) errors.push(`${TLA_DIR}/MessageWindow.candidate.cfg: missing`)
  else if (!parseCfg(candidate).invariants.includes("CandidatePendingIsNewer")) {
    errors.push(`${TLA_DIR}/MessageWindow.candidate.cfg: must check CandidatePendingIsNewer`)
  }
  const windowTla = await readFile(path.join(dir, "MessageWindow.tla"), "utf8").catch(() => null)
  if (windowTla && !definedOperators(windowTla).has("CandidatePendingIsNewer")) {
    errors.push(`${TLA_DIR}/MessageWindow.tla: must define CandidatePendingIsNewer`)
  }
  return errors
}

export function runTlc(root: string, jar: string): string[] {
  const dir = path.join(root, TLA_DIR)
  const errors: string[] = []
  for (const name of MODULES) {
    const result = spawnSync(
      "java",
      [
        "-XX:+UseParallelGC",
        "-cp",
        jar,
        "tlc2.TLC",
        "-workers",
        "2",
        "-cleanup",
        "-nowarning",
        "-metadir",
        path.join(os.tmpdir(), `synergy-tlc-${name}`),
        "-config",
        `${name}.cfg`,
        `${name}.tla`,
      ],
      { cwd: dir, encoding: "utf8" },
    )
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`
    if (result.error) {
      errors.push(`${name}: failed to start TLC (${result.error.message})`)
      continue
    }
    if (result.status !== 0) {
      const tail = output.trim().split("\n").slice(-12).join("\n")
      errors.push(`${name}: TLC exited ${result.status}\n${tail}`)
    }
  }
  return errors
}

async function main() {
  const errors = await checkTlaSpecs(REPO_ROOT)
  const tlc = process.argv.includes("--tlc") || process.env.SYNERGY_TLC === "1"
  if (tlc && errors.length === 0) {
    const jar = process.env.TLA2TOOLS_JAR
    if (!jar) errors.push("TLA2TOOLS_JAR is required when SYNERGY_TLC=1")
    else errors.push(...runTlc(REPO_ROOT, jar))
  }
  if (errors.length === 0) return
  for (const error of errors) console.error(error)
  process.exitCode = 1
}

if (import.meta.main) await main()
