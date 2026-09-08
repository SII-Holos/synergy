import { expect, test } from "bun:test"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { Dag } from "@ericsanchezok/synergy-harness/session/dag"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import type { Tool } from "@ericsanchezok/synergy-harness/tool/tool"
import { DagReadTool, DagWriteTool, DagPatchTool } from "../../src/tools/dag"

async function fixture(run: (ctx: Tool.Context, permissions: string[]) => Promise<void>) {
  await using directory = await tmpdir()
  await ScopeContext.provide({
    scope: await directory.scope(),
    async fn() {
      const session = await Session.create({})
      const permissions: string[] = []
      await run(
        {
          sessionID: session.id,
          messageID: "message",
          agent: "synergy",
          abort: new AbortController().signal,
          metadata() {},
          async ask(input) {
            permissions.push(input.permission)
          },
        },
        permissions,
      )
    },
  })
}
const read = await DagReadTool.init(),
  write = await DagWriteTool.init(),
  patch = await DagPatchTool.init()
const node = (id: string, deps: string[] = []): Dag.Node => ({ id, content: `Research ${id}`, status: "pending", deps })

test("DAG tools persist assignments, promote dependencies and preserve completed nodes", async () => {
  await fixture(async (ctx, permissions) => {
    expect((await read.execute({}, ctx)).title).toBe("empty")
    expect((await patch.execute({ nodes: [{ id: "missing", status: "completed" }] }, ctx)).title).toBe("No DAG")
    const created = await write.execute(
      { nodes: [node("a"), { ...node("b"), assign: "explore" }, node("c", ["a", "b"])] },
      ctx,
    )
    expect(created.title).toBe("0/3 done")
    expect(created.output).toContain("dispatching them in parallel")
    expect(created.metadata.nodes.map((n) => n.status)).toEqual(["running", "running", "pending"])
    const assigned = await patch.execute(
      {
        nodes: [
          { id: "a", task_id: "task-a", session_id: "child-a", memo: "Collect sources" },
          { id: "missing", status: "completed" },
        ],
      },
      ctx,
    )
    expect(assigned.output).toContain('Node "missing" not found')
    expect((await Dag.get(ctx.sessionID))[0]).toMatchObject({
      task_id: "task-a",
      session_id: "child-a",
      memo: "Collect sources",
    })
    await patch.execute(
      {
        nodes: [
          { id: "a", status: "completed" },
          { id: "b", status: "completed" },
        ],
      },
      ctx,
    )
    const loaded = await read.execute({}, ctx)
    expect(loaded.title).toBe("2/3 done")
    expect(loaded.metadata.nodes.find((n) => n.id === "c")?.status).toBe("running")
    for (const change of [
      { id: "a", status: "running" },
      { id: "a", task_id: "replacement" },
      { id: "c", status: "unknown" },
      { id: "c" },
    ]) {
      expect((await patch.execute({ nodes: [change] }, ctx)).title).toBe("Patch failed")
    }
    expect((await Dag.get(ctx.sessionID))[0]?.status).toBe("completed")
    await patch.execute({ nodes: [{ id: "a", memo: "Final source reference" }] }, ctx)
    expect((await Dag.get(ctx.sessionID))[0]?.memo).toBe("Final source reference")
    expect(permissions).toContain("dagwrite")
    expect(permissions).toContain("dagread")
  })
})

test("DAG writes report validation errors, repairs and dropped-running warnings without corrupting state", async () => {
  await fixture(async (ctx) => {
    const invalid = await write.execute({ nodes: [node("a", ["b"]), node("b", ["a"])] }, ctx)
    expect(invalid.title).toBe("Invalid DAG")
    expect(invalid.output).toContain("Circular")
    expect(await Dag.get(ctx.sessionID)).toEqual([])
    const repaired = await write.execute({ nodes: [node("a", ["missing"])] }, ctx)
    expect(repaired.output).toContain("Auto-fixed")
    expect(repaired.metadata.nodes[0]?.deps).toEqual([])
    const replaced = await write.execute({ nodes: [node("b")] }, ctx)
    expect(replaced.output).toContain('Running node "a" was dropped')
    expect((await Dag.get(ctx.sessionID)).map((n) => n.id)).toEqual(["b"])
  })
})
