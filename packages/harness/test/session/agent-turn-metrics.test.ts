import { describe, expect, test } from "bun:test"
import path from "path"
import { AgentTurnProtocol } from "../../src/session/agent-turn/protocol"

const fixture = path.join(import.meta.dir, "fixtures/agent-worker-metrics-forwarder.ts")

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
