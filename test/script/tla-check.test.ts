import { describe, expect, test } from "bun:test"
import path from "node:path"
import { auditModule, checkTlaSpecs, definedOperators, parseCfg } from "../../script/tla-check"

const root = path.resolve(import.meta.dir, "../..")

const windowTla = `------------------------------- MODULE MessageWindow -------------------------------
TypeOK == TRUE
InvPendingFlag == TRUE
InvPendingDisjoint == TRUE
InvCap == TRUE
InvSubset == TRUE
InvTailOnlyInHistory == TRUE
InvLatestClean == TRUE
InvUnloaded == TRUE
InvCursorOnlyHistory == TRUE
InvLatestPageIsSuffix == TRUE
InvHistoryCapKeepsNewerTail == TRUE
InvPendingStep == TRUE
InvHistoryTouchPreserves == TRUE
InvRemovePreserves == TRUE
InvIgnoreUnloaded == TRUE
Spec == TRUE
=============================================================================
`

describe("TLA config audit", () => {
  test("reads specification, invariants, properties, and constants", () => {
    const cfg = parseCfg(`
\\* comment
SPECIFICATION FairSpec
CONSTANT MaxSeq = 3
INVARIANT TypeOK
PROPERTY CaughtUp
`)
    expect(cfg).toEqual({
      specification: "FairSpec",
      constants: ["MaxSeq"],
      invariants: ["TypeOK"],
      properties: ["CaughtUp"],
    })
  })

  test("collects top-level operators", () => {
    expect(definedOperators("KindOf(x) == TRUE\nInvCap == TRUE\n")).toEqual(new Set(["InvCap"]))
  })

  test("rejects a missing message-window invariant", () => {
    const missing = auditModule({
      name: "MessageWindow",
      tla: windowTla,
      cfgText: "SPECIFICATION Spec\nINVARIANT TypeOK\n",
    })
    expect(missing.some((error) => error.includes("missing INVARIANT InvHistoryCapKeepsNewerTail"))).toBe(true)
  })

  test("rejects an invariant the module does not define", () => {
    const errors = auditModule({
      name: "ScopeEpochReplay",
      tla: "Spec == TRUE\nFairSpec == TRUE\n",
      cfgText: "SPECIFICATION FairSpec\nINVARIANT Missing\nPROPERTY CaughtUp\n",
    })
    expect(errors.some((error) => error.includes("Missing is not defined"))).toBe(true)
    expect(errors.some((error) => error.includes("CaughtUp is not defined"))).toBe(true)
  })
})

test("the pilot tree names both specs and their checked invariants", async () => {
  expect(await checkTlaSpecs(root)).toEqual([])
})
