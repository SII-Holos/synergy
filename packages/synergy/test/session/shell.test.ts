import { describe, expect, test } from "bun:test"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { shell } from "../../src/session/shell"
import { tmpdir } from "../fixture/fixture"

describe("session shell", () => {
  test.skipIf(process.platform === "win32")(
    "settles when an exited command leaves an inherited pipe open",
    async () => {
      await using tmp = await tmpdir({ git: true })
      const scope = await tmp.scope()

      await ScopeContext.provide({
        scope,
        fn: async () => {
          const session = await Session.create({})
          try {
            const startedAt = performance.now()
            const result = await shell({
              sessionID: session.id,
              agent: "build",
              model: { providerID: "test", modelID: "test" },
              command: "(sleep 30) &",
            })

            expect(performance.now() - startedAt).toBeLessThan(10_000)
            expect(result.parts.some((part) => part.type === "tool" && part.state.status === "completed")).toBe(true)
          } finally {
            await Session.remove(session.id)
          }
        },
      })
    },
    12_000,
  )
})

test.skipIf(process.platform === "win32")(
  "user shell records full output before bounding the session preview",
  async () => {
    const { RolloutSnapshot } = await import("../../src/session/rollout/snapshot")
    const { RolloutArtifact } = await import("../../src/session/rollout/artifact")
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})
        try {
          const result = await shell({
            sessionID: session.id,
            agent: "synergy",
            model: { providerID: "test", modelID: "test" },
            command: `"${process.execPath}" -e 'process.stdout.write("x".repeat(180000));process.stderr.write("y".repeat(90000))'`,
          })
          const snapshot = await RolloutSnapshot.read({
            kind: "session",
            scopeID: session.scope.id,
            sessionID: session.id,
          })
          expect(snapshot.runs[0].status).toBe("completed")
          expect(snapshot.tools).toHaveLength(1)
          expect(snapshot.processes).toHaveLength(1)
          const chunks = []
          for await (const chunk of RolloutArtifact.read(snapshot.owner, snapshot.processes[0].stream))
            chunks.push(chunk)
          const stream = Buffer.concat(chunks)
          let stdout = 0,
            stderr = 0
          for (let offset = 0; offset < stream.length; ) {
            const length = stream.readUInt32BE(offset + 1)
            if (stream[offset] === 1) stdout += length
            else stderr += length
            offset += length + 5
          }
          expect(stdout).toBe(180000)
          expect(stderr).toBe(90000)
          const part = result.parts[0]
          expect(part.type === "tool" && part.state.status === "completed" && part.state.output.length).toBeLessThan(
            40000,
          )
        } finally {
          await Session.remove(session.id)
        }
      },
    })
  },
)
