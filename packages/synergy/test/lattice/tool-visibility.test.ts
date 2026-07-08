import { describe, expect, test } from "bun:test"
import { SessionModePolicy } from "../../src/session/tool-mode-policy"

const lattice = (mode: "auto" | "collaborative", firstBlueprintStarted?: boolean) => ({
  workflow: { kind: "lattice" as const, runID: "ltr_x", mode, firstBlueprintStarted },
})

describe("Lattice tool visibility", () => {
  test("pathway_* hidden outside a Lattice session", () => {
    expect(SessionModePolicy.visibility({ toolName: "pathway_read", session: {} })).toBeDefined()
    expect(SessionModePolicy.visibility({ toolName: "pathway_patch", session: {} })).toBeDefined()
  })

  test("pathway_* visible inside a Lattice session", () => {
    expect(SessionModePolicy.visibility({ toolName: "pathway_read", session: lattice("auto") })).toBeUndefined()
    expect(SessionModePolicy.visibility({ toolName: "pathway_patch", session: lattice("auto") })).toBeUndefined()
  })

  test("question hidden in auto mode after the first BlueprintLoop", () => {
    expect(SessionModePolicy.visibility({ toolName: "question", session: lattice("auto", true) })).toBeDefined()
    expect(SessionModePolicy.visibility({ toolName: "question", session: lattice("auto", false) })).toBeUndefined()
  })

  test("question always visible in collaborative mode", () => {
    expect(
      SessionModePolicy.visibility({ toolName: "question", session: lattice("collaborative", true) }),
    ).toBeUndefined()
  })

  test("non-lattice, non-pathway tools are unaffected", () => {
    expect(SessionModePolicy.visibility({ toolName: "read", session: {} })).toBeUndefined()
  })
})
