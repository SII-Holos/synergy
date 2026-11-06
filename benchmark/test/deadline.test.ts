import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { executionDeadline } from "../runtime/deadline.mjs"

test("runtime startup has its own deadline before the first model request", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bench-clock-"))
  const outcomes: string[] = []
  const marker = path.join(root, "started.json")
  const clock = executionDeadline({
    marker,
    startupSeconds: 1,
    agentSeconds: 0.04,
    pollMs: 2,
    onTimeout: (stage: string) => outcomes.push(stage),
  })
  try {
    await Bun.sleep(60)
    expect(outcomes).toEqual([])
    await Bun.write(marker, JSON.stringify({ started_at: Date.now() }))
    await Bun.sleep(70)
    expect(outcomes).toEqual(["agent"])
    expect(clock.state.model_started_at).toBeNumber()
  } finally {
    await clock.stop()
    await rm(root, { recursive: true, force: true })
  }
})

test("startup hangs are bounded without claiming a model execution", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bench-clock-"))
  const outcomes: string[] = []
  const clock = executionDeadline({
    marker: path.join(root, "missing.json"),
    startupSeconds: 0.03,
    agentSeconds: 5,
    pollMs: 2,
    onTimeout: (stage: string) => outcomes.push(stage),
  })
  try {
    await Bun.sleep(60)
    expect(outcomes).toEqual(["startup"])
    expect(clock.state.model_started_at).toBeNull()
  } finally {
    await clock.stop()
    await rm(root, { recursive: true, force: true })
  }
})
