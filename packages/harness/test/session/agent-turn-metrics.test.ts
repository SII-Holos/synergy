import { describe, expect, test } from "bun:test"
import path from "path"
import { createTurnMetrics } from "../../src/session/agent-turn/metrics"
import { AgentTurnProtocol } from "../../src/session/agent-turn/protocol"

const fixture = path.join(import.meta.dir, "fixtures/agent-worker-metrics-forwarder.ts")
const row = { name: "llm.fetch.headers", value: 42, unit: "ms" as const, module: "llm" as const }
type MetricFrame = Extract<AgentTurnProtocol.WorkerToHost, { type: "metrics" }>

describe("Agent turn metric queue", () => {
  test("bounds a synchronous burst and flushes valid ordered frames on the next microtask", async () => {
    const frames: MetricFrame[] = []
    const queue = createTurnMetrics("bounded-turn", (frame) => frames.push(frame))
    const limit = AgentTurnProtocol.METRIC_ROWS_MAX * 4
    for (let value = 0; value < limit + 3; value++) queue.record({ ...row, value })

    expect(frames).toEqual([])
    expect(queue.dropped).toBe(3)
    await Promise.resolve()
    expect(frames).toHaveLength(4)
    expect(frames.flatMap((frame) => frame.rows.map((entry) => entry.value))).toEqual(
      Array.from({ length: limit }, (_, value) => value),
    )
    for (const frame of frames) {
      expect(frame.requestId).toBe("bounded-turn")
      expect(frame.rows).toHaveLength(AgentTurnProtocol.METRIC_ROWS_MAX)
      expect(AgentTurnProtocol.parseWorkerToHost(frame)).toEqual(frame)
      expect(() => AgentTurnProtocol.assertIpcFrameBound(frame)).not.toThrow()
    }
    queue.close()
  })

  test("keeps bounded scalar labels and truncates names and string values", async () => {
    const frames: MetricFrame[] = []
    const queue = createTurnMetrics("labels-turn", (frame) => frames.push(frame))
    queue.record({
      ...row,
      name: "n".repeat(AgentTurnProtocol.METRIC_STRING_MAX_CHARS + 1),
      labels: {
        object: { nested: true },
        array: [1],
        undefined: undefined,
        infinity: Infinity,
        nan: NaN,
        text: "v".repeat(AgentTurnProtocol.METRIC_LABEL_VALUE_MAX_CHARS + 1),
        number: 7,
        boolean: false,
        null: null,
        ...Object.fromEntries(
          Array.from({ length: AgentTurnProtocol.METRIC_LABEL_KEYS_MAX }, (_, index) => [`extra${index}`, index]),
        ),
      },
    })
    queue.record(row)
    await Promise.resolve()

    const bounded = frames[0]!.rows[0]!
    expect(bounded.name).toBe("n".repeat(AgentTurnProtocol.METRIC_STRING_MAX_CHARS))
    expect(bounded.labels).toEqual({
      text: "v".repeat(AgentTurnProtocol.METRIC_LABEL_VALUE_MAX_CHARS),
      number: 7,
      boolean: false,
      null: null,
      ...Object.fromEntries(
        Array.from({ length: AgentTurnProtocol.METRIC_LABEL_KEYS_MAX - 4 }, (_, index) => [`extra${index}`, index]),
      ),
    })
    expect(frames[0]!.rows[1]!.labels).toEqual({})
    expect(AgentTurnProtocol.parseWorkerToHost(frames[0])).toEqual(frames[0])
    expect(queue.dropped).toBe(0)
    queue.close()
  })

  test("drops invalid rows without blocking a subsequent valid measurement", async () => {
    const frames: MetricFrame[] = []
    const queue = createTurnMetrics("validation-turn", (frame) => frames.push(frame))
    queue.record({ ...row, value: NaN })
    queue.record({ ...row, sampleRate: 2 })
    queue.record({ ...row, traceId: "t".repeat(AgentTurnProtocol.METRIC_STRING_MAX_CHARS + 1) })
    queue.record({ ...row, traceId: "trace", callID: "call", sampleRate: 0.5 })
    await Promise.resolve()

    expect(queue.dropped).toBe(3)
    expect(frames.flatMap((frame) => frame.rows)).toEqual([
      { ...row, labels: {}, traceId: "trace", callID: "call", sampleRate: 0.5 },
    ])
    queue.close()
  })

  test("close drains before returning and a late callback cannot enter the next turn", async () => {
    const frames: MetricFrame[] = []
    const first = createTurnMetrics("first-turn", (frame) => frames.push(frame))
    first.record(row)
    first.close()
    expect(frames).toHaveLength(1)
    const second = createTurnMetrics("second-turn", (frame) => frames.push(frame))
    const late = Promise.resolve().then(() => first.record({ ...row, value: 99 }))
    second.record({ ...row, value: 2 })
    await late
    first.close()
    second.close()

    expect(frames.map((frame) => [frame.requestId, frame.rows.map((entry) => entry.value)])).toEqual([
      ["first-turn", [42]],
      ["second-turn", [2]],
    ])
    expect(first.dropped).toBe(1)
    expect(second.dropped).toBe(0)
  })

  test("counts a failed send as dropped and continues forwarding later batches", async () => {
    const frames: MetricFrame[] = []
    const queue = createTurnMetrics("send-turn", (frame) => {
      if (frame.rows[0]!.value === 0) throw new Error("transport unavailable")
      frames.push(frame)
    })
    for (let value = 0; value <= AgentTurnProtocol.METRIC_ROWS_MAX; value++) queue.record({ ...row, value })
    await Promise.resolve()
    expect(queue.dropped).toBe(AgentTurnProtocol.METRIC_ROWS_MAX)
    expect(frames.flatMap((frame) => frame.rows.map((entry) => entry.value))).toEqual([
      AgentTurnProtocol.METRIC_ROWS_MAX,
    ])
    queue.record(row)
    queue.close()
    expect(frames.flatMap((frame) => frame.rows.map((entry) => entry.value))).toEqual([
      AgentTurnProtocol.METRIC_ROWS_MAX,
      42,
    ])
  })
})

// Exercise the bounded turn queue over a real Bun IPC channel.
function spawnWorker(burst: number) {
  const frames: AgentTurnProtocol.WorkerToHost[] = []
  const child = Bun.spawn({
    cmd: [process.execPath, "run", fixture],
    cwd: path.resolve(import.meta.dir, "../.."),
    env: {
      ...process.env,
      SYNERGY_AGENT_WORKER: "1",
      SYNERGY_AGENT_PARENT_PID: String(process.pid),
      SYNERGY_METRIC_BURST: String(burst),
    },
    ipc(message) {
      frames.push(message as AgentTurnProtocol.WorkerToHost)
      child.send({ type: "ack" })
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  return { child, frames }
}

describe("Agent worker metric forwarding", () => {
  test("coalesces a burst into bounded frames the host parses", async () => {
    const { child, frames } = spawnWorker(1_000)
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])

    expect(exitCode, stderr).toBe(0)
    const metrics = frames.filter(
      (frame): frame is Extract<AgentTurnProtocol.WorkerToHost, { type: "metrics" }> => frame.type === "metrics",
    )
    expect(metrics.length).toBeGreaterThan(0)
    for (const frame of metrics) {
      expect(frame.requestId).toBe("fixture-turn")
      expect(frame.rows.length).toBeGreaterThan(0)
      expect(frame.rows.length).toBeLessThanOrEqual(AgentTurnProtocol.METRIC_ROWS_MAX)
      expect(AgentTurnProtocol.parseWorkerToHost(frame)).toEqual(frame)
      expect(() => AgentTurnProtocol.assertIpcFrameBound(frame)).not.toThrow()
    }
    expect(metrics[0]!.rows[0]).toMatchObject({
      name: "llm.fetch.headers",
      unit: "ms",
      module: "llm",
      labels: { provider: "provider", model: "model" },
    })

    const dropped = (JSON.parse(stdout) as { dropped: number }).dropped
    const forwarded = metrics.reduce((total, frame) => total + frame.rows.length, 0)
    expect(forwarded + dropped).toBe(1_000)
    expect(dropped).toBeGreaterThan(0)
  })

  test("forwards a single record without dropping it", async () => {
    const { child, frames } = spawnWorker(1)
    const [stdout, , exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])

    expect(exitCode).toBe(0)
    const metrics = frames.filter(
      (frame): frame is Extract<AgentTurnProtocol.WorkerToHost, { type: "metrics" }> => frame.type === "metrics",
    )
    expect(metrics.flatMap((frame) => frame.rows)).toEqual([
      expect.objectContaining({ name: "llm.fetch.headers", value: 0, unit: "ms" }),
    ])
    expect((JSON.parse(stdout) as { dropped: number }).dropped).toBe(0)
  })
})
