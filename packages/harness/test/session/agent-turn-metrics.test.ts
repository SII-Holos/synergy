import { describe, expect, spyOn, test } from "bun:test"
import path from "path"
import { AgentTurnProtocol } from "../../src/session/agent-turn/protocol"
import { AgentWorkerPool, type AgentWorkerPoolOptions } from "../../src/session/agent-turn/worker-pool"
import type { AgentWorkerProcess, SpawnAgentWorkerProcessOptions } from "../../src/session/agent-turn/process-host"
import { ObservabilityMetrics } from "../../src/observability/metrics"

const fixture = path.join(import.meta.dir, "fixtures/agent-worker-metrics-forwarder.ts")

// The runner installs a process-global metric forwarder at import time, so it is
// driven in a child process; `bun test` shares one process across test files.
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

const hostOptions: AgentWorkerPoolOptions = {
  size: 1,
  minIdle: 1,
  idleTimeoutMs: 60_000,
  maxQueued: 8,
  maxQueuedBytes: 8 * 1024 * 1024,
  maxTurns: 64,
  maxRssBytes: 1024 * 1024 * 1024,
  maxHeapBytes: 768 * 1024 * 1024,
  idleBaselineRecycle: false,
  idleBaselineRssGrowthBytes: 256,
  idleBaselineExternalGrowthBytes: 128,
  cancelGraceMs: 10,
  heartbeatTimeoutMs: 60_000,
}

// Feeds frames captured from a real worker into the real pool handler, so the
// producer, the protocol parser, and the host recording path are all exercised.
function hostPool() {
  let onMessage!: SpawnAgentWorkerProcessOptions["onMessage"]
  const spawn = (options: SpawnAgentWorkerProcessOptions): AgentWorkerProcess => {
    onMessage = options.onMessage
    return {
      process: { exitCode: null, kill() {} } as unknown as Bun.Subprocess,
      send() {},
      async stop() {},
    }
  }
  return { pool: new AgentWorkerPool(hostOptions, spawn), deliver: (frame: unknown) => onMessage(frame as never) }
}

describe("Agent worker metric forwarding into the host", () => {
  test("records every forwarded row with its name, value, unit, and labels", async () => {
    const { child, frames } = spawnWorker(3)
    using recorded = spyOn(ObservabilityMetrics, "record")
    await child.exited

    const { pool, deliver } = hostPool()
    for (const frame of frames) {
      const parsed = AgentTurnProtocol.parseWorkerToHost(frame)
      if (parsed.type === "metrics") deliver(parsed)
    }

    const calls = (
      recorded as unknown as {
        mock: { calls: Array<Array<{ name?: string; value?: number; unit?: string; labels?: unknown }>> }
      }
    ).mock.calls.map((call) => call[0])
    const project = (row: {
      name?: string
      value?: number
      unit?: string
      labels?: unknown
    }): { name?: string; value?: number; unit?: string; labels?: unknown } => ({
      name: row.name,
      value: row.value,
      unit: row.unit,
      labels: row.labels,
    })
    const expected = frames
      .flatMap((frame) => (frame.type === "metrics" ? frame.rows : []))
      .map((row) => ({ name: row.name, value: row.value, unit: row.unit, labels: row.labels }))
    expect(expected).toHaveLength(3)
    expect(calls.map(project)).toEqual(expected)
    await pool.stop()
  })
})
