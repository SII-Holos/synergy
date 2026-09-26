import { expect, spyOn, test } from "bun:test"
import path from "node:path"
import { z } from "zod"
import { ToolTaskScheduler } from "../../../harness/src/session/tool-scheduler"
import { SessionProcessor } from "../../../harness/src/session/processor"
import { Cortex, CortexConcurrency } from "@ericsanchezok/synergy-harness/cortex"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionInvoke } from "@ericsanchezok/synergy-harness/session/invoke"
import { SessionManager } from "@ericsanchezok/synergy-harness/session/manager"
import { FileMutation } from "../../src/file/mutation"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { testRuntime } from "../support/runtime"

async function until(fn: () => boolean) {
  const deadline = Date.now() + 10_000
  while (!fn()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for Cortex admission")
    await Bun.sleep(5)
  }
}

test("a Cortex child waiting for files yields its only admission slot to an independent child", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    await using a = await tmpdir()
    await using b = await tmpdir()
    await ScopeContext.provide({
      scope: await a.scope(),
      fn: async () => {
        CortexConcurrency.configure(1)
        const parent = await Session.create({})
        const writer = await Session.create({})
        const childA = await Session.create({ parentID: parent.id })
        const childB = await Session.create({
          parentID: parent.id,
          workspace: { type: "directory", scopeID: parent.scope.id, path: b.path },
        })
        const held = Promise.withResolvers<void>()
        const release = Promise.withResolvers<void>()
        const writes: string[] = []
        const running = SessionManager.run(writer.id, async () => {
          await FileMutation.write({ path: path.join(a.path, "held.txt"), content: "held", expectedVersion: null })
          held.resolve()
          await release.promise
        })
        await held.promise
        using invoke = spyOn(SessionInvoke, "invokeInternal").mockImplementation((input) =>
          SessionManager.run(input.sessionID, async () => {
            await FileMutation.write({
              path: path.join(ScopeContext.current.directory, "child.txt"),
              content: input.sessionID,
              expectedVersion: null,
            })
            writes.push(input.sessionID)
            throw new Error("Controlled end of invocation fixture")
          }),
        )
        const launch = (sessionID: string) =>
          Cortex.launch({
            description: "Workspace admission",
            prompt: "Write child file",
            agent: "developer",
            sessionID,
            parentSessionID: parent.id,
            parentMessageID: "msg_workspace_admission",
            model: { providerID: "fixture", modelID: "fixture" },
            notifyParentOnComplete: false,
          })
        let first: Awaited<ReturnType<typeof launch>> | undefined
        let second: Awaited<ReturnType<typeof launch>> | undefined
        try {
          first = await launch(childA.id)
          await until(() => CortexConcurrency.globalStatus().running === 0)
          expect(writes).toEqual([])
          second = await launch(childB.id)
          await Cortex.waitFor(second.id, 10)
          expect(writes).toEqual([childB.id])
          release.resolve()
          await running
          await Cortex.waitFor(first.id, 10)
          expect(writes).toEqual([childB.id, childA.id])
          expect(CortexConcurrency.globalStatus().running).toBe(0)
        } finally {
          release.resolve()
          await running
          if (first) {
            await Cortex.cancel(first.id)
            await Cortex.drain(first.id)
          }
          if (second) {
            await Cortex.cancel(second.id)
            await Cortex.drain(second.id)
          }
        }
      },
    })
  })
}, 30_000)

test("Cortex launch and wait transfer the parent's same-Workspace write reservation", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    await using tmp = await tmpdir()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        CortexConcurrency.configure(1)
        const parent = await Session.create({})
        using invoke = spyOn(SessionInvoke, "invokeInternal").mockImplementation((input) =>
          SessionManager.run(input.sessionID, async () => {
            await FileMutation.write({
              path: path.join(tmp.path, "child.txt"),
              content: "child",
              expectedVersion: null,
            })
            throw new Error("Controlled end of invocation fixture")
          }),
        )
        let child: Awaited<ReturnType<typeof Cortex.launch>> | undefined
        try {
          await SessionManager.run(parent.id, async () => {
            await FileMutation.write({
              path: path.join(tmp.path, "parent.txt"),
              content: "parent",
              expectedVersion: null,
            })
            child = await Cortex.launch({
              description: "Same Workspace child",
              prompt: "Write child file",
              agent: "developer",
              parentSessionID: parent.id,
              parentMessageID: "msg_workspace_handoff",
              model: { providerID: "fixture", modelID: "fixture" },
              notifyParentOnComplete: false,
            })
            const result = await Cortex.waitFor(child.id, 10)
            expect(result?.status).toBe("error")
            expect(await Bun.file(path.join(tmp.path, "child.txt")).text()).toBe("child")
            await FileMutation.write({
              path: path.join(tmp.path, "after.txt"),
              content: "after",
              expectedVersion: null,
            })
          })
        } finally {
          if (child) {
            await Cortex.cancel(child.id)
            await Cortex.drain(child.id)
          }
        }
      },
    })
  })
}, 30_000)

test("finishing one parallel tool releases Cortex capacity when its remaining tool waits for files", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    await using a = await tmpdir()
    await using b = await tmpdir()
    await using c = await tmpdir()
    await ScopeContext.provide({
      scope: await a.scope(),
      fn: async () => {
        CortexConcurrency.configure(1)
        const parent = await Session.create({})
        const writer = await Session.create({
          workspace: { type: "directory", scopeID: parent.scope.id, path: b.path },
        })
        const childA = await Session.create({ parentID: parent.id })
        const childC = await Session.create({
          parentID: parent.id,
          workspace: { type: "directory", scopeID: parent.scope.id, path: c.path },
        })
        const held = Promise.withResolvers<void>()
        const release = Promise.withResolvers<void>()
        const firstWriting = Promise.withResolvers<void>()
        const finishFirst = Promise.withResolvers<void>()
        const firstDone = Promise.withResolvers<void>()
        const secondStarted = Promise.withResolvers<void>()
        const owner = SessionManager.run(writer.id, async () => {
          await FileMutation.write({ path: path.join(b.path, "held.txt"), content: "held", expectedVersion: null })
          held.resolve()
          await release.promise
        })
        await held.promise
        const scheduler = new ToolTaskScheduler({ maxConcurrent: 2, maxQueued: 8 })
        const slots = new Map<string, ReturnType<typeof SessionProcessor.createSlot>>()
        const processor = {
          message: { id: "msg_parallel" },
          beginExecution(callID: string) {
            let slot = slots.get(callID)
            if (!slot) {
              slot = SessionProcessor.createSlot(callID)
              slots.set(callID, slot)
            }
            return slot
          },
        }
        using invoke = spyOn(SessionInvoke, "invokeInternal").mockImplementation((input) =>
          SessionManager.run(input.sessionID, async () => {
            if (input.sessionID === childC.id)
              await FileMutation.write({
                path: path.join(c.path, "independent.txt"),
                content: "independent",
                expectedVersion: null,
              })
            else {
              const dispatch = (callID: string, execute: () => Promise<unknown>) =>
                scheduler.dispatch({
                  sessionID: input.sessionID,
                  generation: 1,
                  messageID: "msg_parallel",
                  callID,
                  toolName: "write",
                  executor: "file",
                  input: {},
                  processor,
                  signal: new AbortController().signal,
                  tool: {
                    inputSchema: z.object({}),
                    async execute() {
                      await execute()
                      processor.beginExecution(callID).complete({}, { title: callID, output: callID, metadata: {} })
                      return {}
                    },
                  },
                })
              const first = dispatch("first", () =>
                FileMutation.write({
                  path: path.join(a.path, "first.txt"),
                  content: "first",
                  expectedVersion: null,
                  async validate() {
                    firstWriting.resolve()
                    await finishFirst.promise
                  },
                }),
              ).then((value) => {
                firstDone.resolve()
                return value
              })
              await firstWriting.promise
              const second = dispatch("second", async () => {
                secondStarted.resolve()
                return FileMutation.write({
                  path: path.join(b.path, "second.txt"),
                  content: "second",
                  expectedVersion: null,
                })
              })
              await Promise.all([first, second])
            }
            throw new Error("Controlled end of parallel invocation fixture")
          }),
        )
        const launch = (sessionID: string) =>
          Cortex.launch({
            description: "Parallel files",
            prompt: "Write files",
            agent: "developer",
            sessionID,
            parentSessionID: parent.id,
            parentMessageID: "msg_parallel_files",
            model: { providerID: "fixture", modelID: "fixture" },
            notifyParentOnComplete: false,
          })
        let first: Awaited<ReturnType<typeof launch>> | undefined
        let independent: Awaited<ReturnType<typeof launch>> | undefined
        try {
          first = await launch(childA.id)
          await secondStarted.promise
          await until(() => scheduler.stats().waiting === 1)
          expect(CortexConcurrency.globalStatus().running).toBe(1)
          finishFirst.resolve()
          await firstDone.promise
          await until(() => CortexConcurrency.globalStatus().running === 0)
          independent = await launch(childC.id)
          await Cortex.waitFor(independent.id, 10)
          expect(await Bun.file(path.join(c.path, "independent.txt")).text()).toBe("independent")
          release.resolve()
          await owner
          await Cortex.waitFor(first.id, 10)
          expect(await Bun.file(path.join(b.path, "second.txt")).text()).toBe("second")
        } finally {
          finishFirst.resolve()
          release.resolve()
          await owner
          if (first) {
            await Cortex.cancel(first.id)
            await Cortex.drain(first.id)
          }
          if (independent) {
            await Cortex.cancel(independent.id)
            await Cortex.drain(independent.id)
          }
          await scheduler.stop()
        }
      },
    })
  })
}, 30_000)
