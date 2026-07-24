import { describe, expect, test } from "bun:test"
import type { Tool as AITool } from "ai"
import { SessionProcessor } from "../../src/session/processor"
import { ToolScheduler, ToolTaskScheduler } from "../../src/session/tool-scheduler"

function processor() {
  const slots = new Map<string, SessionProcessor.ToolExecutionSlot>()
  const executions = new Map<string, Promise<unknown>>()
  return {
    message: { id: "msg_test" },
    beginExecution(callID: string) {
      const existing = slots.get(callID)
      if (existing) return existing
      const slot = SessionProcessor.createSlot(callID)
      slots.set(callID, slot)
      return slot
    },
    executeOnce<T>(callID: string, execute: () => Promise<T>) {
      const existing = executions.get(callID)
      if (existing) return existing as Promise<T>
      const result = Promise.resolve().then(execute)
      executions.set(callID, result)
      return result
    },
    async updateToolCallState() {},
  }
}

describe("ToolTaskScheduler", () => {
  test("deduplicates a replayed call before invoking the executable tool", async () => {
    const scheduler = new ToolTaskScheduler({ maxConcurrent: 2, maxQueued: 8 })
    const target = processor()
    let executions = 0
    const tool = {
      async execute(input: unknown) {
        executions++
        target.beginExecution("call_same").complete(input, {
          title: "done",
          output: "completed",
          metadata: {},
        })
        return { title: "done", output: "completed", metadata: {} }
      },
    } as unknown as AITool

    const task = {
      sessionID: "ses_test",
      generation: 1,
      messageID: "msg_test",
      callID: "call_same",
      toolName: "probe",
      input: { value: 1 },
      tool,
      processor: target,
      signal: new AbortController().signal,
    }

    const [first, second] = await Promise.all([scheduler.dispatch(task), scheduler.dispatch(task)])

    expect(first).toBe(second)
    expect(executions).toBe(1)
    expect(first.state).toBe("completed")
    expect(await target.beginExecution("call_same").promise).toMatchObject({ status: "completed" })
    await scheduler.stop()
  })

  test("cancels queued work without consuming an execution slot", async () => {
    const scheduler = new ToolTaskScheduler({ maxConcurrent: 1, maxQueued: 8 })
    const target = processor()
    let releaseFirst!: () => void
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const started: string[] = []
    const tool = {
      async execute(input: { id: string }, options: { toolCallId: string }) {
        started.push(input.id)
        if (input.id === "first") await firstBlocked
        target.beginExecution(options.toolCallId).complete(input, {
          title: input.id,
          output: input.id,
          metadata: {},
        })
        return { title: input.id, output: input.id, metadata: {} }
      },
    } as unknown as AITool
    const first = scheduler.dispatch({
      sessionID: "ses_test",
      generation: 1,
      messageID: "msg_test",
      callID: "call_first",
      toolName: "probe",
      input: { id: "first" },
      tool,
      processor: target,
      signal: new AbortController().signal,
    })
    await Promise.resolve()

    const queuedAbort = new AbortController()
    const second = scheduler.dispatch({
      sessionID: "ses_test",
      generation: 1,
      messageID: "msg_test",
      callID: "call_second",
      toolName: "probe",
      input: { id: "second" },
      tool,
      processor: target,
      signal: queuedAbort.signal,
    })
    queuedAbort.abort()
    releaseFirst()

    expect((await first).state).toBe("completed")
    expect((await second).state).toBe("cancelled")
    expect(started).toEqual(["first"])
    await scheduler.stop()
  })

  test("fails one task when the queue is full without disturbing running work", async () => {
    const scheduler = new ToolTaskScheduler({ maxConcurrent: 1, maxQueued: 1 })
    const target = processor()
    let release!: () => void
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    const tool = {
      async execute(input: { id: string }, options: { toolCallId: string }) {
        if (input.id === "running") await blocked
        target.beginExecution(options.toolCallId).complete(input, {
          title: input.id,
          output: input.id,
          metadata: {},
        })
        return { title: input.id, output: input.id, metadata: {} }
      },
    } as unknown as AITool
    const dispatch = (callID: string, id: string) =>
      scheduler.dispatch({
        sessionID: "ses_test",
        generation: 1,
        messageID: "msg_test",
        callID,
        toolName: "probe",
        input: { id },
        tool,
        processor: target,
        signal: new AbortController().signal,
      })

    const running = dispatch("call_running", "running")
    await Promise.resolve()
    const queued = dispatch("call_queued", "queued")
    const rejected = await dispatch("call_rejected", "rejected")
    release()

    expect(rejected.state).toBe("failed")
    expect(rejected.error).toContain("queue is full")
    expect((await running).state).toBe("completed")
    expect((await queued).state).toBe("completed")
    await scheduler.stop()
  })

  test("bounds aggregate queued input bytes while a tool slot is occupied", async () => {
    const scheduler = new ToolTaskScheduler({ maxConcurrent: 1, maxQueued: 8, maxQueuedBytes: 64 })
    const target = processor()
    let release!: () => void
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    const tool = {
      async execute(input: { id: string }, options: { toolCallId: string }) {
        if (input.id === "running") await blocked
        target.beginExecution(options.toolCallId).complete(input, {
          title: input.id,
          output: input.id,
          metadata: {},
        })
      },
    } as unknown as AITool
    const dispatch = (callID: string, input: { id: string; payload?: string }) =>
      scheduler.dispatch({
        sessionID: "ses_test",
        generation: 1,
        messageID: "msg_test",
        callID,
        toolName: "probe",
        input,
        tool,
        processor: target,
        signal: new AbortController().signal,
      })

    const running = dispatch("call_running_bytes", { id: "running" })
    await Promise.resolve()
    const rejected = await dispatch("call_queued_bytes", { id: "queued", payload: "x".repeat(128) })
    release()

    expect(rejected.state).toBe("failed")
    expect(rejected.error).toContain("queue exceeded")
    expect((await running).state).toBe("completed")
    await scheduler.stop()
  })

  test("admits another executor class while one class has reached its limit", async () => {
    const scheduler = new ToolTaskScheduler({
      maxConcurrent: 2,
      maxQueued: 8,
      executorConcurrency: { local_process: 1, control_plane: 1 },
    })
    const target = processor()
    let release!: () => void
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    const started: string[] = []
    const tool = {
      async execute(input: { id: string }, options: { toolCallId: string }) {
        started.push(input.id)
        if (input.id === "local-running") await blocked
        target.beginExecution(options.toolCallId).complete(input, {
          title: input.id,
          output: input.id,
          metadata: {},
        })
      },
    } as unknown as AITool
    const dispatch = (callID: string, id: string, executor: "local_process" | "control_plane") =>
      scheduler.dispatch({
        sessionID: "ses_test",
        generation: 1,
        messageID: "msg_test",
        callID,
        toolName: "probe",
        executor,
        input: { id },
        tool,
        processor: target,
        signal: new AbortController().signal,
      })

    const first = dispatch("call_local_running", "local-running", "local_process")
    const second = dispatch("call_local_queued", "local-queued", "local_process")
    const control = dispatch("call_control", "control", "control_plane")
    expect((await control).state).toBe("completed")
    expect(started).toEqual(["local-running", "control"])
    release()
    expect((await first).state).toBe("completed")
    expect((await second).state).toBe("completed")
    await scheduler.stop()
  })

  test("bounds an executor-saturated queue even when global capacity remains", async () => {
    const scheduler = new ToolTaskScheduler({
      maxConcurrent: 4,
      maxQueued: 1,
      executorConcurrency: { local_process: 1 },
    })
    const target = processor()
    let release!: () => void
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    const tool = {
      async execute(input: { id: string }, options: { toolCallId: string }) {
        if (input.id === "running") await blocked
        target.beginExecution(options.toolCallId).complete(input, {
          title: input.id,
          output: input.id,
          metadata: {},
        })
      },
    } as unknown as AITool
    const dispatch = (callID: string, id: string) =>
      scheduler.dispatch({
        sessionID: "ses_test",
        generation: 1,
        messageID: "msg_test",
        callID,
        toolName: "bash",
        executor: "local_process",
        input: { id },
        tool,
        processor: target,
        signal: new AbortController().signal,
      })

    const running = dispatch("call_running", "running")
    await Promise.resolve()
    const queued = dispatch("call_queued", "queued")
    const rejected = await dispatch("call_rejected", "rejected")

    expect(rejected.state).toBe("failed")
    expect(rejected.error).toContain("queue is full")
    release()
    expect((await running).state).toBe("completed")
    expect((await queued).state).toBe("completed")
    await scheduler.stop()
  })

  test("bounds shutdown when an active tool ignores cancellation", async () => {
    const scheduler = new ToolTaskScheduler({
      maxConcurrent: 1,
      maxQueued: 1,
      shutdownGraceMs: 5,
    })
    const target = processor()
    let release!: () => void
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    const tool = {
      async execute(input: unknown, options: { toolCallId: string }) {
        await blocked
        target.beginExecution(options.toolCallId).complete(input, {
          title: "late",
          output: "late",
          metadata: {},
        })
      },
    } as unknown as AITool
    const task = scheduler.dispatch({
      sessionID: "ses_test",
      generation: 1,
      messageID: "msg_test",
      callID: "call_stuck",
      toolName: "probe",
      input: {},
      tool,
      processor: target,
      signal: new AbortController().signal,
    })
    await Promise.resolve()

    await scheduler.stop()
    expect(await task).toMatchObject({
      state: "interrupted",
      error: "Tool scheduler shutdown grace elapsed",
    })
    expect((await target.beginExecution("call_stuck").promise).status).toBe("error")
    release()
    await Bun.sleep(0)
    expect((await task).state).toBe("interrupted")
  })

  test("restores default options when the runtime is reconfigured", async () => {
    await ToolScheduler.stop()
    ToolScheduler.configure({ maxConcurrent: 1 })
    expect(ToolScheduler.stats().maxConcurrent).toBe(1)
    await ToolScheduler.stop()

    ToolScheduler.configure()
    expect(ToolScheduler.stats().maxConcurrent).toBeGreaterThan(1)
    await ToolScheduler.stop()
  })

  test("rejects new work as soon as runtime shutdown starts", async () => {
    await ToolScheduler.stop()
    ToolScheduler.configure({ maxConcurrent: 1, shutdownGraceMs: 5 })
    const target = processor()
    let release!: () => void
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    const tool = {
      async execute(input: unknown, options: { toolCallId: string }) {
        await blocked
        target.beginExecution(options.toolCallId).complete(input, {
          title: "late",
          output: "late",
          metadata: {},
        })
      },
    } as unknown as AITool
    const input = {
      sessionID: "ses_test",
      generation: 1,
      messageID: "msg_test",
      callID: "call_shutdown_running",
      toolName: "probe",
      input: {},
      tool,
      processor: target,
      signal: new AbortController().signal,
    }
    const running = ToolScheduler.dispatch(input)
    await Promise.resolve()

    const stopping = ToolScheduler.stop()
    await expect(
      ToolScheduler.dispatch({
        ...input,
        callID: "call_shutdown_rejected",
      }),
    ).rejects.toThrow("Tool scheduler is stopping")

    await stopping
    release()
    expect((await running).state).toBe("interrupted")
    ToolScheduler.configure()
    await ToolScheduler.stop()
  })

  test("accepts new work after runtime shutdown completes", async () => {
    await ToolScheduler.stop()
    const target = processor()
    const tool = {
      async execute(input: unknown, options: { toolCallId: string }) {
        target.beginExecution(options.toolCallId).complete(input, {
          title: "restarted",
          output: "restarted",
          metadata: {},
        })
      },
    } as unknown as AITool

    const result = await ToolScheduler.dispatch({
      sessionID: "ses_test",
      generation: 1,
      messageID: "msg_test",
      callID: "call_after_shutdown",
      toolName: "probe",
      input: {},
      tool,
      processor: target,
      signal: new AbortController().signal,
    })

    expect(result.state).toBe("completed")
    await ToolScheduler.stop()
  })
})
