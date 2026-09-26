import { describe, expect, test } from "bun:test"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { shell } from "../../src/session/shell"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
import path from "node:path"
import { WorkspaceAccess } from "@ericsanchezok/synergy-harness/workspace/access"
import { SessionManager } from "@ericsanchezok/synergy-harness/session/manager"
import { Shell } from "@ericsanchezok/synergy-harness/util/shell"
const runtime = await testRuntime()

describe("session shell", () => {
  test.skipIf(process.platform === "win32")(
    "drains a finite background command before settling the user shell",
    () =>
      runtime.run(async () => {
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
                command: "(sleep 0.4; echo background-finished) &",
              })

              expect(performance.now() - startedAt).toBeLessThan(10_000)
              expect(
                result.parts.some(
                  (part) =>
                    part.type === "tool" &&
                    part.state.status === "completed" &&
                    part.state.output.includes("background-finished"),
                ),
              ).toBe(true)
              expect(result.parts.some((part) => part.type === "tool" && part.state.status === "completed")).toBe(true)
            } finally {
              await Session.remove(session.id)
            }
          },
        })
      }),
    12_000,
  )
})

test(
  "user shell retains write ownership through detached descendants",
  () =>
    runtime.run(async () => {
      await using directory = await tmpdir()
      await ScopeContext.provide({
        scope: await directory.scope(),
        async fn() {
          const session = await Session.create()
          const marker = path.join(directory.path, "started")
          const stop = path.join(directory.path, "stop")
          const done = path.join(directory.path, "done")
          const child = path.join(directory.path, "descendant.mjs")
          const root = path.join(directory.path, "root.mjs")
          await Bun.write(
            child,
            `await Bun.write(${JSON.stringify(marker)}, String(process.pid)); while (!(await Bun.file(${JSON.stringify(stop)}).exists())) await Bun.sleep(20); await Bun.write(${JSON.stringify(done)}, 'finished')`,
          )
          await Bun.write(
            root,
            `import {spawn} from 'node:child_process'; const child=spawn(process.execPath,[${JSON.stringify(child)}],{env:{},stdio:'ignore',detached:true}); child.unref()`,
          )
          const running = shell({
            sessionID: session.id,
            agent: "synergy",
            model: { providerID: "test", modelID: "test" },
            command: `"${process.execPath}" "${root}"`,
          })
          let completed: Awaited<typeof running> | undefined
          let failed: unknown
          void running.then(
            (result) => {
              completed = result
            },
            (error) => {
              failed = error
            },
          )
          try {
            const deadline = Date.now() + 10000
            while (!(await Bun.file(marker).exists())) {
              if (failed) throw failed
              if (completed)
                throw new Error(
                  `User shell exited before descendant startup (${Shell.preferred()}): ${JSON.stringify(completed.parts.filter((part) => part.type === "tool"))}`,
                )
              if (Date.now() >= deadline) throw new Error("User shell descendant did not start")
              await Bun.sleep(10)
            }
            await expect(
              WorkspaceAccess.write([directory.path], async () => {}, AbortSignal.timeout(100)),
            ).rejects.toMatchObject({ name: "TimeoutError" })
            expect(await Bun.file(done).exists()).toBe(false)
            await Bun.write(stop, "stop")
            await running
            expect(await Bun.file(done).text()).toBe("finished")
            await WorkspaceAccess.write([directory.path], async () => {})
          } finally {
            await Bun.write(stop, "stop")
            await running
            await Session.remove(session.id)
          }
        },
      })
    }),
  20000,
)

test(
  "cancelling a user shell waiting for write ownership never launches its command",
  () =>
    runtime.run(async () => {
      await using directory = await tmpdir()
      await ScopeContext.provide({
        scope: await directory.scope(),
        async fn() {
          const session = await Session.create()
          const marker = path.join(directory.path, "must-not-start")
          const blocker = await WorkspaceAccess.process(null)
          const running = shell({
            sessionID: session.id,
            agent: "synergy",
            model: { providerID: "test", modelID: "test" },
            command: `echo started > "${marker}"`,
          })
          void running.catch(() => {})
          try {
            await Bun.sleep(200)
            expect(await Bun.file(marker).exists()).toBe(false)
            expect(SessionManager.signalAbort(session.id)).toBe("signaled")
            await expect(running).rejects.toMatchObject({ name: "AbortError" })
            const messages = await Session.messages({ sessionID: session.id })
            const parts = messages.flatMap((message) => message.parts).filter((part) => part.type === "tool")
            expect(parts).toHaveLength(1)
            expect(parts[0].state.status).toBe("error")
          } finally {
            SessionManager.signalAbort(session.id)
            await blocker.release()
            await running.catch(() => {})
            await Session.remove(session.id)
          }
          expect(await Bun.file(marker).exists()).toBe(false)
        },
      })
    }),
  15000,
)

test.skipIf(process.platform === "win32")("user shell records full output before bounding the session preview", () =>
  runtime.run(async () => {
    const { RolloutSnapshot } = await import("@ericsanchezok/synergy-harness/session/rollout/snapshot")
    const { RolloutArtifact } = await import("@ericsanchezok/synergy-harness/session/rollout/artifact")
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
  }),
)

afterRuntimeTests(() => runtime.close())
