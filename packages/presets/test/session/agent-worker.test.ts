import { expect, test } from "bun:test"
import { spawnAgentWorkerProcess } from "@ericsanchezok/synergy-harness/session/agent-turn/process-host"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()

test(
  "full source assembly starts its registered agent worker and shuts it down",
  () =>
    runtime.run(async () => {
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
    }),
  30_000,
)

afterRuntimeTests(() => runtime.close())
