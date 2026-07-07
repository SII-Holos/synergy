import { describe, expect, test } from "bun:test"
import { LatticeStore } from "../../src/lattice/store"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { PathwayPatchTool } from "../../src/tool/pathway-patch"
import type { Tool } from "../../src/tool/tool"
import { tmpdir } from "../fixture/fixture"

async function withScope<T>(fn: () => Promise<T>): Promise<T> {
  await using tmp = await tmpdir({ git: true })
  const scope = (await Scope.fromDirectory(tmp.path)).scope
  return ScopeContext.provide({ scope, fn })
}

function ctx(sessionID: string): Tool.Context {
  return {
    sessionID,
    messageID: "",
    callID: "",
    agent: "test-strategist",
    abort: AbortSignal.any([]),
    metadata: () => {},
    ask: async () => {},
  }
}

async function execute(input: unknown, sessionID: string) {
  const tool = await PathwayPatchTool.init()
  return tool.execute(input as never, ctx(sessionID))
}

describe("pathway_patch", () => {
  test("ignores empty placeholder intents while creating the initial Pathway", async () => {
    await withScope(async () => {
      const session = await Session.create({})
      await LatticeStore.reset({ sessionID: session.id, mode: "auto" })

      const result = await execute(
        {
          bindCurrentBlueprint: { noteID: "", version: 0 },
          recordResult: { stepID: "", resultSummary: "" },
          steps: [{ title: "Inventory", objective: "Group issues" }],
        },
        session.id,
      )

      const run = await LatticeStore.get(ScopeContext.current.scope.id, session.id)
      expect(result.metadata.phase).toBe("step_blueprinting")
      expect(run.phase).toBe("step_blueprinting")
      expect(run.pathway).toHaveLength(1)
      expect(run.pathway[0].title).toBe("Inventory")
      expect(run.pathway[0].blueprintNoteID).toBeUndefined()
    })
  })
})
