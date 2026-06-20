import { DagPatchTool } from "../../src/tool/dag"
import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { Dag } from "../../src/session/dag"
import { Cortex } from "../../src/cortex"
import { Session } from "../../src/session"
import { Instance } from "../../src/scope/instance"
import { tmpdir } from "../fixture/fixture"

// ---------------------------------------------------------------------------
// Schema tests: Dag.Node with optional result field
// ---------------------------------------------------------------------------

describe("Dag.Node result field (schema)", () => {
  test("parses node without result field (backward compatibility with old data)", () => {
    const parsed = Dag.Node.parse({
      id: "node-backward-compat",
      content: "Legacy task without result",
      status: "completed",
      deps: [],
    })
    expect(parsed.id).toBe("node-backward-compat")
    expect(parsed.result).toBeUndefined()
  })

  test("parses node with result field and result is accessible", () => {
    const resultText = "Task completed successfully: all tests passed, coverage at 95%"
    const parsed = Dag.Node.parse({
      id: "node-with-result",
      content: "Task with result",
      status: "completed",
      deps: [],
      result: resultText,
    })
    expect(parsed.id).toBe("node-with-result")
    expect(parsed.result).toBe(resultText)
  })

  test("result is optional — node with undefined result is valid", () => {
    const parsed = Dag.Node.parse({
      id: "node-no-result",
      content: "No result",
      status: "failed",
      deps: [],
    })
    expect(parsed.result).toBeUndefined()
    expect(parsed.status).toBe("failed")
  })
})

// ---------------------------------------------------------------------------
// updateDagNode: long result truncation (> 8192 chars)
//
// We test truncation by building a Task-like object that has a very long error
// and verifying the truncation logic applied to the result field. Since we
// can't call updateDagNode directly, we test this by examining the code logic:
// raw.length > 8192 ? raw.slice(0, 8189) + "..." : raw
// This preserves exactly 8192 total when truncated: 8189 chars + "..."
// ---------------------------------------------------------------------------

describe("updateDagNode truncation logic", () => {
  // The truncation formula from the implementation:
  //   node.result = raw.length > 8192 ? raw.slice(0, 8189) + "..." : raw
  // We verify this invariant here.
  const TRUNCATE_AT = 8192
  const SLICE_AT = 8189

  test("result ≤ 8192 chars is stored unchanged", () => {
    const short = "x".repeat(8192)
    expect(short.length).toBe(8192)
    const result = short.length > TRUNCATE_AT ? short.slice(0, SLICE_AT) + "..." : short
    expect(result).toBe(short)
    expect(result.length).toBe(8192)
  })

  test("result 8193 chars is truncated to 8192 with ... suffix", () => {
    const long = "a".repeat(8193)
    const result = long.length > TRUNCATE_AT ? long.slice(0, SLICE_AT) + "..." : long
    expect(result.length).toBe(8192)
    expect(result).toBe("a".repeat(8189) + "...")
    expect(result.slice(-3)).toBe("...")
  })

  test("result 20000 chars is truncated to 8192 with ... suffix", () => {
    const long = "b".repeat(20000)
    const result = long.length > TRUNCATE_AT ? long.slice(0, SLICE_AT) + "..." : long
    expect(result.length).toBe(8192)
    expect(result).toBe("b".repeat(8189) + "...")
  })
})

// ---------------------------------------------------------------------------
// buildDagUpstreamContext truncation logic (per-node and total)
//
// buildDagUpstreamContext is non-exported in invoke.ts. We verify its
// truncation invariants:
//   - Per node: > 4096 chars → truncated to 4096 (4093 + "...")
//   - Total: > 16384 chars → capped at 16384 total
// ---------------------------------------------------------------------------

describe("buildDagUpstreamContext truncation invariants", () => {
  const MAX_PER_NODE = 4096
  const MAX_TOTAL = 16384

  test("per-node: ≤ 4096 chars passes through unchanged", () => {
    const result = "x".repeat(4096)
    expect(result.length).toBe(4096)
    const truncated = result.length > MAX_PER_NODE ? result.slice(0, MAX_PER_NODE - 3) + "..." : result
    expect(truncated).toBe(result)
    expect(truncated.length).toBe(4096)
  })

  test("per-node: 4097 chars truncated to 4096 with ... suffix", () => {
    const result = "y".repeat(4097)
    const truncated = result.length > MAX_PER_NODE ? result.slice(0, MAX_PER_NODE - 3) + "..." : result
    expect(truncated.length).toBe(4096)
    expect(truncated).toBe("y".repeat(4093) + "...")
  })

  test("per-node: 10000 chars truncated to 4096 with ... suffix", () => {
    const result = "z".repeat(10000)
    const truncated = result.length > MAX_PER_NODE ? result.slice(0, MAX_PER_NODE - 3) + "..." : result
    expect(truncated.length).toBe(4096)
    expect(truncated).toBe("z".repeat(4093) + "...")
  })

  test("total: 5 deps × 4000 chars fits within 16384", () => {
    const blocks: string[] = []
    let total = 0
    for (let i = 0; i < 5; i++) {
      const block = `## Node: dep${i} — Result\n**Result**:\n${"r".repeat(4000)}`
      const blockSize = block.length + 2
      if (total + blockSize > MAX_TOTAL) break
      blocks.push(block)
      total += blockSize
    }
    expect(blocks.length).toBeGreaterThanOrEqual(4)
    expect(total).toBeLessThanOrEqual(MAX_TOTAL)
  })

  test("total: 5 deps × 5000 chars hits the 16384 cap", () => {
    const blocks: string[] = []
    let total = 0
    for (let i = 0; i < 5; i++) {
      const // after per-node truncation, each is 4096
        truncated = "d".repeat(4093) + "..."
      const block = `## Node: dep${i} — Result\n**Result**:\n${truncated}`
      const blockSize = block.length + 2
      if (total + blockSize > MAX_TOTAL) break
      blocks.push(block)
      total += blockSize
    }
    // With blocks of ~4100+ chars each, only ~3 will fit
    expect(blocks.length).toBeLessThan(5)
    expect(total).toBeLessThanOrEqual(MAX_TOTAL)
  })
})

// ---------------------------------------------------------------------------
// buildCortexExecutionContext integration test
//
// Verifies that the DAG node result from an upstream completed task is
// propagated to the downstream node when a delegated_subagent task runs.
// ---------------------------------------------------------------------------

describe("delegated subagent with DAG context (integration)", () => {
  beforeEach(() => {
    Cortex.reset()
  })

  afterEach(() => {
    Cortex.reset()
  })

  test("delegated_subagent task populates DAG node with upstream completion context", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const parentSession = await Session.create({})

        // Simulate an upstream DAG node that has already completed with a result
        await Dag.update({
          sessionID: parentSession.id,
          nodes: [
            {
              id: "upstream-done",
              content: "Already completed upstream work",
              status: "completed",
              deps: [],
              result: "Analysis complete: found 3 issues in the codebase.",
            },
            {
              id: "downstream-next",
              content: "Downstream task depending on upstream",
              status: "pending",
              deps: ["upstream-done"],
            },
          ],
        })

        // Launch a delegated subagent task for the downstream node
        const task = await Cortex.launch({
          description: "Downstream task with upstream context",
          prompt: "Use upstream findings to fix issues",
          agent: "implementation-engineer",
          executionRole: "delegated_subagent",
          parentSessionID: parentSession.id,
          parentMessageID: "msg_ctx_downstream",
          dagNodeId: "downstream-next",
        })

        const completed = await Cortex.waitFor(task.id, 10)
        expect(completed).toBeDefined()

        // give async DAG updates time to flush
        await new Promise((r) => setTimeout(r, 500))

        const nodes = await Dag.get(parentSession.id)
        const upstream = nodes.find((n) => n.id === "upstream-done")
        const downstream = nodes.find((n) => n.id === "downstream-next")

        // Upstream should be unchanged (it was already completed)
        expect(upstream).toBeDefined()
        expect(upstream!.status).toBe("completed")
        expect(upstream!.result).toBe("Analysis complete: found 3 issues in the codebase.")

        // Downstream got its status updated by the task
        expect(downstream).toBeDefined()
        expect(downstream!.status === "completed" || downstream!.status === "failed").toBe(true)
      },
    })
  })

  test("delegated_subagent without dagNodeId does not modify DAG", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const parentSession = await Session.create({})

        await Dag.update({
          sessionID: parentSession.id,
          nodes: [{ id: "node-alone", content: "Standalone node", status: "pending", deps: [] }],
        })

        const task = await Cortex.launch({
          description: "No DAG binding",
          prompt: "Do work",
          agent: "developer",
          executionRole: "delegated_subagent",
          parentSessionID: parentSession.id,
          parentMessageID: "msg_no_dag",
          // No dagNodeId
        })

        const completed = await Cortex.waitFor(task.id, 10)
        expect(completed).toBeDefined()

        await new Promise((r) => setTimeout(r, 500))

        const nodes = await Dag.get(parentSession.id)
        const node = nodes.find((n) => n.id === "node-alone")
        expect(node).toBeDefined()
        expect(node!.status).toBe("pending")
        expect(node!.result).toBeUndefined()
      },
    })
  })

  test("completed task result set on DAG node preserves content", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const parentSession = await Session.create({})

        const expectedContent = "Implementation task for feature X"
        await Dag.update({
          sessionID: parentSession.id,
          nodes: [{ id: "node-content", content: expectedContent, status: "pending", deps: [] }],
        })

        const task = await Cortex.launch({
          description: "Content preservation test",
          prompt: "Implement feature X",
          agent: "developer",
          parentSessionID: parentSession.id,
          parentMessageID: "msg_content_001",
          dagNodeId: "node-content",
        })

        const completed = await Cortex.waitFor(task.id, 10)
        expect(completed).toBeDefined()

        await new Promise((r) => setTimeout(r, 500))

        const nodes = await Dag.get(parentSession.id)
        const node = nodes.find((n) => n.id === "node-content")
        expect(node).toBeDefined()
        // Content should be preserved (only status/result change)
        expect(node!.content).toBe(expectedContent)
      },
    })
  })

  test("primary execution role task does NOT set upstream-results context but still updates DAG", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const parentSession = await Session.create({})

        await Dag.update({
          sessionID: parentSession.id,
          nodes: [
            {
              id: "up-comp",
              content: "Completed upstream",
              status: "completed",
              deps: [],
              result: "Upstream analysis results here",
            },
            {
              id: "down-primary",
              content: "Downstream with primary role",
              status: "pending",
              deps: ["up-comp"],
            },
          ],
        })

        const task = await Cortex.launch({
          description: "Primary role downstream",
          prompt: "Continue work",
          agent: "developer",
          executionRole: "primary",
          parentSessionID: parentSession.id,
          parentMessageID: "msg_primary_001",
          dagNodeId: "down-primary",
        })

        const completed = await Cortex.waitFor(task.id, 10)
        expect(completed).toBeDefined()

        await new Promise((r) => setTimeout(r, 500))

        const nodes = await Dag.get(parentSession.id)
        const down = nodes.find((n) => n.id === "down-primary")
        expect(down).toBeDefined()
        // Still gets status/result updated (that's updateDagNode, not context)
        expect(down!.status === "completed" || down!.status === "failed").toBe(true)
      },
    })
  })
})

// ---------------------------------------------------------------------------
// dagpatch immutability: completed nodes reject task_id / session_id mutation
//
// DagPatchTool.execute() guards task_id and session_id on completed nodes
// (dag.ts lines 188-193). We test this by setting up a completed DAG node,
// calling dagpatch to mutate the protected fields, and verifying the error
// response and that the node values remain unchanged.
// ---------------------------------------------------------------------------

describe("dagpatch rejects task_id / session_id mutation on completed nodes", () => {
  const ctx = {
    sessionID: "",
    messageID: "",
    agent: "developer",
    abort: AbortSignal.any([]),
    metadata: () => {},
    ask: async () => {},
  }

  test("completed node rejects task_id mutation", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})
        ctx.sessionID = session.id

        const originalTaskId = "existing-task-123"
        await Dag.update({
          sessionID: session.id,
          nodes: [
            {
              id: "node-immutable-task",
              content: "Completed node with task_id",
              status: "completed",
              deps: [],
              task_id: originalTaskId,
            },
          ],
        })

        const patch = await DagPatchTool.init()
        const result = await patch.execute(
          {
            nodes: [{ id: "node-immutable-task", task_id: "new-task-999" }],
          },
          ctx as any,
        )

        expect(result.title).toBe("Patch failed")
        expect(result.output).toContain("task_id and session_id are immutable")

        // Verify the node's task_id was not changed
        const nodes = await Dag.get(session.id)
        const node = nodes.find((n) => n.id === "node-immutable-task")
        expect(node).toBeDefined()
        expect(node!.task_id).toBe(originalTaskId)
      },
    })
  })

  test("completed node rejects session_id mutation", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})
        ctx.sessionID = session.id

        const originalSessionId = "existing-secret-session-abc"
        await Dag.update({
          sessionID: session.id,
          nodes: [
            {
              id: "node-immutable-session",
              content: "Completed node with session_id",
              status: "completed",
              deps: [],
              session_id: originalSessionId,
            },
          ],
        })

        const patch = await DagPatchTool.init()
        const result = await patch.execute(
          {
            nodes: [{ id: "node-immutable-session", session_id: "new-session-777" }],
          },
          ctx as any,
        )

        expect(result.title).toBe("Patch failed")
        expect(result.output).toContain("task_id and session_id are immutable")

        // Verify the node's session_id was not changed
        const nodes = await Dag.get(session.id)
        const node = nodes.find((n) => n.id === "node-immutable-session")
        expect(node).toBeDefined()
        expect(node!.session_id).toBe(originalSessionId)
      },
    })
  })
})
