import { expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import {
  resolveAgentWorkerCommand,
  spawnAgentWorkerProcess,
} from "@ericsanchezok/synergy-harness/session/agent-turn/process-host"

test("full source assembly starts its registered agent worker and shuts it down", async () => {
  expect(resolveAgentWorkerCommand()).toEqual([
    process.execPath,
    "run",
    fileURLToPath(new URL("../../src/agent-worker.ts", import.meta.url)),
  ])
  const handshake = Promise.withResolvers<void>()
  let stopping = false
  const worker = spawnAgentWorkerProcess({
    onMessage(message) {
      if (message.type === "ready") worker.send({ type: "ping" })
      if (message.type === "pong") handshake.resolve()
    },
    onExit(exitCode, signal) {
      if (stopping) return
      const error = new Error(`Full agent worker exited before shutdown (${exitCode}, ${signal})`)
      handshake.reject(error)
    },
  })
  try {
    await handshake.promise
  } finally {
    stopping = true
    await worker.stop(5_000)
  }
  expect(await worker.process.exited).toBe(0)
}, 30_000)
