import { describe, expect, test } from "bun:test"
import { SessionModePolicy } from "../../src/session/tool-mode-policy"

const lattice = (mode: "auto" | "collaborative", executing = false) => ({
  workflow: { kind: "lattice" as const, runID: "ltr_x", mode },
  ...(executing ? { blueprint: { loopID: "bll_x", loopRole: "execution" as const } } : {}),
})

describe("Lattice tool visibility", () => {
  test("Lattice parent tools are hidden outside a Lattice session", () => {
    expect(SessionModePolicy.visibility({ toolName: "pathway_read", session: {} })).toBeDefined()
    expect(SessionModePolicy.visibility({ toolName: "pathway_write", session: {} })).toBeDefined()
    expect(SessionModePolicy.visibility({ toolName: "lattice_submit", session: {} })).toBeDefined()
  })

  test("Lattice parent tools are visible inside a non-executing Lattice session", () => {
    expect(SessionModePolicy.visibility({ toolName: "pathway_read", session: lattice("auto") })).toBeUndefined()
    expect(SessionModePolicy.visibility({ toolName: "pathway_write", session: lattice("auto") })).toBeUndefined()
    expect(SessionModePolicy.visibility({ toolName: "lattice_submit", session: lattice("auto") })).toBeUndefined()
  })

  test("Lattice parent tools are hidden while the execution BlueprintLoop owns the session", () => {
    expect(SessionModePolicy.visibility({ toolName: "pathway_read", session: lattice("auto", true) })).toBeDefined()
    expect(SessionModePolicy.visibility({ toolName: "pathway_write", session: lattice("auto", true) })).toBeDefined()
    expect(SessionModePolicy.visibility({ toolName: "lattice_submit", session: lattice("auto", true) })).toBeDefined()
  })

  test("question remains available without a Session phase mirror", () => {
    expect(SessionModePolicy.visibility({ toolName: "question", session: lattice("auto") })).toBeUndefined()
    expect(SessionModePolicy.visibility({ toolName: "question", session: lattice("collaborative") })).toBeUndefined()
  })

  test("non-lattice, non-pathway tools are unaffected", () => {
    expect(SessionModePolicy.visibility({ toolName: "read", session: {} })).toBeUndefined()
  })
})
