import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { CortexConcurrency } from "@ericsanchezok/synergy-harness/cortex/concurrency"
import { Cortex } from "@ericsanchezok/synergy-harness/cortex/manager"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionExport } from "@ericsanchezok/synergy-harness/session/session-export"
import { SessionImport } from "@ericsanchezok/synergy-harness/session/session-import"
import { Identifier } from "@ericsanchezok/synergy-harness/id/id"
import { Hono } from "hono"
import { generateSpecs } from "hono-openapi"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { testRuntime as harnessRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { registerLocalRuntime } from "@ericsanchezok/synergy-local-runtime/register"
import { Server } from "../../src/server/server"
import { CortexRoute } from "../../src/server/cortex"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()

const originalGlobalConcurrency = process.env.SYNERGY_CORTEX_GLOBAL_CONCURRENCY

beforeEach(() =>
  runtime.run(() => {
    delete process.env.SYNERGY_CORTEX_GLOBAL_CONCURRENCY
    CortexConcurrency.reset()
    Cortex.reset()
  }),
)

afterEach(() =>
  runtime.run(() => {
    if (originalGlobalConcurrency === undefined) delete process.env.SYNERGY_CORTEX_GLOBAL_CONCURRENCY
    else process.env.SYNERGY_CORTEX_GLOBAL_CONCURRENCY = originalGlobalConcurrency
    CortexConcurrency.reset()
    Cortex.reset()
  }),
)

function memorySnapshot(rssGiB: number, arrayBuffersGiB = 0) {
  return {
    rssBytes: rssGiB * 1024 ** 3,
    heapUsedBytes: 1,
    heapTotalBytes: 1,
    externalBytes: 1,
    arrayBuffersBytes: arrayBuffersGiB * 1024 ** 3,
  }
}

describe("Cortex routes", () => {
  test("mounted detail and output operations expose optional expected Session identities", () =>
    runtime.run(async () => {
      const spec = await generateSpecs(new Hono().route("/cortex/tasks", CortexRoute()))
      for (const [path, operationID] of [
        ["/cortex/tasks/{taskID}", "cortex.get"],
        ["/cortex/tasks/{taskID}/output", "cortex.output"],
      ]) {
        const operation = spec.paths?.[path]?.get
        expect(operation?.operationId).toBe(operationID)
        const parameters = operation?.parameters?.flatMap((parameter) =>
          "name" in parameter
            ? [{ name: parameter.name, in: parameter.in, required: parameter.required ?? false }]
            : [],
        )
        expect(parameters).toContainEqual({ name: "parentSessionID", in: "query", required: false })
        expect(parameters).toContainEqual({ name: "sessionID", in: "query", required: false })
      }
    }))

  test("a reused ordinary child receives canonical metadata before live detail, output and cancel reads", () =>
    runtime.run(() =>
      ScopeContext.provide({
        scope: Scope.home(),
        workspace: null,
        fn: async () => {
          const parent = await Session.create({})
          const child = await Session.create({ parentID: parent.id })
          expect(child.cortex).toBeUndefined()
          await expect(
            Cortex.prepare({
              description: "Do not reuse the root",
              prompt: "Root identity stays unchanged",
              agent: "fixture",
              parentSessionID: parent.id,
              parentMessageID: "msg_reuse_root_denied",
              sessionID: parent.id,
              notifyParentOnComplete: false,
            }),
          ).rejects.toThrow("does not belong")
          expect((await Session.get(parent.id)).cortex).toBeUndefined()
          const task = await Cortex.prepare({
            description: "Reuse an ordinary child",
            prompt: "Retain these instructions",
            agent: "fixture",
            parentSessionID: parent.id,
            parentMessageID: "msg_reuse_ordinary_child",
            sessionID: child.id,
            executionRole: "delegated_subagent",
            tools: { read: true },
            output: { mode: "final_response" },
            notifyParentOnComplete: false,
          })
          const app = Server.App()
          expect((await app.request(`/cortex/tasks/${task.id}`)).status).toBe(200)
          expect((await app.request(`/cortex/tasks/${task.id}/output`)).status).toBe(200)
          expect((await Session.get(child.id)).cortex).toMatchObject({
            taskID: task.id,
            parentSessionID: parent.id,
            parentMessageID: task.parentMessageID,
            description: task.description,
            prompt: task.prompt,
            status: "queued",
            executionRole: "delegated_subagent",
            tools: { read: true },
            outputConfig: { mode: "final_response" },
          })
          expect((await app.request(`/cortex/tasks/${task.id}/cancel`, { method: "POST" })).status).toBe(200)
          expect((await Session.get(child.id)).cortex?.status).toBe("cancelled")
          await Cortex.drain()
          const detail = await app.request(
            `/cortex/tasks/${task.id}?parentSessionID=${parent.id}&sessionID=${child.id}`,
          )
          expect(detail.status).toBe(200)
          expect(await detail.json()).toMatchObject({ id: task.id, sessionID: child.id, status: "cancelled" })
          const next = await Cortex.prepare({
            description: "Reuse the terminal child again",
            prompt: "New instructions",
            agent: "fixture",
            parentSessionID: parent.id,
            parentMessageID: "msg_reuse_terminal_child",
            sessionID: child.id,
            notifyParentOnComplete: false,
          })
          expect(Cortex.get(task.id)?.status).toBe("cancelled")
          expect((await app.request(`/cortex/tasks/${task.id}?sessionID=${child.id}`)).status).toBe(404)
          expect((await app.request(`/cortex/tasks/${next.id}`)).status).toBe(200)
          await Cortex.cancel(next.id)
          await Cortex.drain()
          Cortex.reset()
          const durable = await app.request(
            `/cortex/tasks/${next.id}?parentSessionID=${parent.id}&sessionID=${child.id}`,
          )
          expect(durable.status).toBe(200)
          expect(await durable.json()).toMatchObject({ id: next.id, prompt: "New instructions", status: "cancelled" })
        },
      }),
    ))

  test.each(["live", "evicted"] as const)(
    "transcript-imported task IDs require exact identity and reject ambiguous %s reads",
    runtime.bind(async (phase) => {
      await using fixture = await tmpdir()
      await ScopeContext.provide({
        scope: await fixture.scope(),
        fn: async () => {
          const parent = await Session.create({})
          const message = await Session.updateMessage({
            id: Identifier.ascending("message"),
            sessionID: parent.id,
            role: "user",
            agent: "fixture",
            model: { providerID: "fixture", modelID: "fixture" },
            time: { created: Date.now() },
          })
          await Session.updatePart({
            id: Identifier.ascending("part"),
            sessionID: parent.id,
            messageID: message.id,
            type: "text",
            text: "Delegate the original task",
          })
          const task = await Cortex.prepare({
            description: "Original task before transcript import",
            prompt: "Original instructions",
            agent: "fixture",
            parentSessionID: parent.id,
            parentMessageID: message.id,
            notifyParentOnComplete: false,
          })
          const originalOutput = { mode: "final_response" as const, value: "Original durable result" }
          task.output = originalOutput
          await Session.update(task.sessionID, (draft) => {
            draft.cortex!.output = originalOutput
          })
          await Cortex.cancel(task.id)
          await Cortex.drain()
          const imported = await SessionImport.fromReport(
            await SessionExport.generate({ sessionID: parent.id, mode: "full" }),
          )
          const copy = imported.sessions.find((entry) => entry.sourceSessionID === task.sessionID)!.session
          expect(copy.id).not.toBe(task.sessionID)
          expect(copy.cortex).toMatchObject({ taskID: task.id, parentSessionID: imported.rootSessionID })
          const importedOutput = { mode: "final_response" as const, value: "Imported durable result" }
          await Session.update(copy.id, (draft) => {
            draft.cortex!.output = importedOutput
          })
          const app = Server.App()
          const url = `/cortex/tasks/${task.id}?scopeID=${parent.scope.id}`
          if (phase === "evicted") Cortex.reset()
          const unqualified = await app.request(url)
          expect(unqualified.status).toBe(phase === "live" ? 200 : 404)
          expect((await app.request(`/cortex/tasks/${task.id}/output?scopeID=${parent.scope.id}`)).status).toBe(
            phase === "live" ? 200 : 404,
          )
          if (phase === "live") expect(await unqualified.json()).toMatchObject({ sessionID: task.sessionID })
          for (const expected of [
            { parentSessionID: parent.id, sessionID: task.sessionID, output: originalOutput },
            { parentSessionID: imported.rootSessionID, sessionID: copy.id, output: importedOutput },
          ]) {
            expect(await Cortex.getVisibleTaskForOutput(expected.parentSessionID, task.id)).toMatchObject(expected)
            const identities: Record<string, string>[] = [
              { parentSessionID: expected.parentSessionID },
              { sessionID: expected.sessionID },
              { parentSessionID: expected.parentSessionID, sessionID: expected.sessionID },
            ]
            for (const identity of identities) {
              const query = new URLSearchParams({ scopeID: parent.scope.id, ...identity })
              const detail = await app.request(`/cortex/tasks/${task.id}?${query}`)
              expect(detail.status).toBe(200)
              expect(await detail.json()).toMatchObject({ id: task.id, ...expected })
              const output = await app.request(`/cortex/tasks/${task.id}/output?${query}`)
              expect(output.status).toBe(200)
              expect((await output.json()).output).toEqual(expected.output)
            }
          }
          const mismatched = new URLSearchParams({
            scopeID: parent.scope.id,
            parentSessionID: parent.id,
            sessionID: copy.id,
          })
          expect((await app.request(`/cortex/tasks/${task.id}?${mismatched}`)).status).toBe(404)
          expect((await app.request(`/cortex/tasks/${task.id}/output?${mismatched}`)).status).toBe(404)
        },
      })
    }),
  )

  test("list and bootstrap use one small summary while detail and output read the durable child after eviction", () =>
    runtime.run(() =>
      ScopeContext.provide({
        scope: Scope.home(),
        workspace: null,
        fn: async () => {
          const parent = await Session.create({ title: "Summary HTTP parent" })
          const prompt = "private HTTP prompt ".repeat(32_768)
          const output = { mode: "structured" as const, value: { text: "private HTTP output ".repeat(32_768) } }
          const error = "private HTTP stack\n".repeat(8_192)
          const task = await Cortex.prepare({
            description: "Summary HTTP task",
            prompt,
            agent: "fixture",
            category: "http-fixture",
            parentSessionID: parent.id,
            parentMessageID: "msg_http_summary",
            notifyParentOnComplete: false,
          })
          task.output = output
          task.error = error
          await Session.update(task.sessionID, (draft) => {
            draft.cortex!.output = output
            draft.cortex!.error = error
          })
          await Cortex.cancel(task.id)
          await Cortex.drain()
          const app = Server.App()
          const list = await app.request(`/cortex/tasks?sessionID=${parent.id}`)
          expect(list.status).toBe(200)
          const summaries = await list.json()
          expect(summaries).toHaveLength(1)
          const bootstrap = await app.request("/scope/bootstrap")
          expect(bootstrap.status).toBe(200)
          const bootstrapData = await bootstrap.json()
          expect(bootstrapData.cortex).toEqual(summaries)
          const serializedBootstrap = JSON.stringify(bootstrapData)
          expect(summaries[0]).toMatchObject({ id: task.id, status: "cancelled", usage: { cost: task.usage?.cost } })
          expect(summaries[0].usage).not.toHaveProperty("accounting")
          for (const key of ["prompt", "output", "outputConfig", "error", "tools", "owner"])
            expect(summaries[0]).not.toHaveProperty(key)
          expect(JSON.stringify(summaries).length).toBeLessThan(4_096)
          Cortex.reset()
          expect(Cortex.get(task.id)).toBeUndefined()
          const detail = await app.request(`/cortex/tasks/${task.id}`)
          expect(detail.status).toBe(200)
          expect(await detail.json()).toMatchObject({ id: task.id, prompt, output, error, category: "http-fixture" })
          const result = await app.request(`/cortex/tasks/${task.id}/output`)
          expect(result.status).toBe(200)
          expect(await result.json()).toMatchObject({ taskID: task.id, status: "cancelled", output, error })
          for (const marker of ["private HTTP prompt", "private HTTP output", "private HTTP stack"])
            expect(serializedBootstrap.includes(marker)).toBe(false)
        },
      }),
    ))

  test("hidden and foreign-Scope tasks are denied for live and durable detail, output, and cancellation", () =>
    runtime.run(async () => {
      await using foreign = await tmpdir()
      const foreignScope = await foreign.scope()
      const hidden = await ScopeContext.provide({
        scope: Scope.home(),
        workspace: null,
        fn: async () => {
          const parent = await Session.create({})
          return Cortex.prepare({
            description: "Hidden task",
            prompt: "secret",
            agent: "fixture",
            parentSessionID: parent.id,
            parentMessageID: "msg_hidden_http",
            visibility: "hidden",
            notifyParentOnComplete: false,
          })
        },
      })
      const task = await ScopeContext.provide({
        scope: foreignScope,
        fn: async () => {
          const parent = await Session.create({})
          return Cortex.prepare({
            description: "Foreign task",
            prompt: "secret",
            agent: "fixture",
            parentSessionID: parent.id,
            parentMessageID: "msg_foreign_http",
            notifyParentOnComplete: false,
          })
        },
      })
      const app = Server.App()
      for (const candidate of [hidden, task]) {
        expect((await app.request(`/cortex/tasks/${candidate.id}`)).status).toBe(404)
        expect((await app.request(`/cortex/tasks/${candidate.id}/output`)).status).toBe(404)
        for (const identity of [
          `sessionID=${candidate.sessionID}`,
          `parentSessionID=${candidate.parentSessionID}&sessionID=${candidate.sessionID}`,
        ]) {
          expect((await app.request(`/cortex/tasks/${candidate.id}?${identity}`)).status).toBe(404)
          expect((await app.request(`/cortex/tasks/${candidate.id}/output?${identity}`)).status).toBe(404)
        }
        expect((await app.request(`/cortex/tasks/${candidate.id}/cancel`, { method: "POST" })).status).toBe(404)
      }
      expect((await app.request(`/cortex/tasks/${task.id}?scopeID=${foreignScope.id}`)).status).toBe(200)
      await ScopeContext.provide({ scope: Scope.home(), workspace: null, fn: () => Cortex.cancel(hidden.id) })
      await ScopeContext.provide({ scope: foreignScope, fn: () => Cortex.cancel(task.id) })
      await Cortex.drain()
      Cortex.reset()
      for (const candidate of [hidden, task]) {
        expect((await app.request(`/cortex/tasks/${candidate.id}`)).status).toBe(404)
        expect((await app.request(`/cortex/tasks/${candidate.id}/output`)).status).toBe(404)
        for (const identity of [
          `sessionID=${candidate.sessionID}`,
          `parentSessionID=${candidate.parentSessionID}&sessionID=${candidate.sessionID}`,
        ]) {
          expect((await app.request(`/cortex/tasks/${candidate.id}?${identity}`)).status).toBe(404)
          expect((await app.request(`/cortex/tasks/${candidate.id}/output?${identity}`)).status).toBe(404)
        }
      }
      expect((await app.request(`/cortex/tasks/${task.id}?scopeID=${foreignScope.id}`)).status).toBe(200)
      expect((await app.request("/cortex/tasks/ctx_missing/output")).status).toBe(404)
      expect((await app.request(`/cortex/tasks/${task.id}?parentSessionID=invalid`)).status).toBe(400)
      expect((await app.request(`/cortex/tasks/${task.id}/output?sessionID=invalid`)).status).toBe(400)
    }))

  test("full task bodies survive closing and reopening the SQLite Runtime without a live task registry", async () => {
    await using home = await tmpdir()
    const open = () => harnessRuntime({ home: home.path, composition: { register: () => registerLocalRuntime() } })
    const first = await open()
    const prompt = "reopened full prompt ".repeat(8_192)
    const output = { mode: "final_response" as const, value: "reopened full output ".repeat(8_192) }
    let taskID = ""
    try {
      await first.run(() =>
        ScopeContext.provide({
          scope: Scope.home(),
          workspace: null,
          fn: async () => {
            const parent = await Session.create({})
            const task = await Cortex.prepare({
              description: "Reopened HTTP task",
              prompt,
              agent: "fixture",
              parentSessionID: parent.id,
              parentMessageID: "msg_http_reopen",
              notifyParentOnComplete: false,
            })
            taskID = task.id
            await Cortex.cancel(task.id)
            await Session.update(task.sessionID, (draft) => {
              draft.cortex!.output = output
              draft.time.archived = Date.now()
            })
            await Cortex.drain()
            Cortex.reset()
          },
        }),
      )
    } finally {
      await first.close()
    }
    await using second = await open()
    await second.run(async () => {
      expect(Cortex.get(taskID)).toBeUndefined()
      const detail = await Server.App().request(`/cortex/tasks/${taskID}`)
      expect(detail.status).toBe(200)
      expect(await detail.json()).toMatchObject({ id: taskID, prompt, output })
      const result = await Server.App().request(`/cortex/tasks/${taskID}/output`)
      expect(result.status).toBe(200)
      expect(await result.json()).toMatchObject({ taskID, output })
    })
  })

  test("returns configured, effective, and memory-pressure concurrency status", () =>
    runtime.run(async () => {
      const response = await Server.App().request("/cortex/tasks/concurrency")

      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({
        configured: null,
        environment: null,
        effective: 8,
        memoryPressureLimit: null,
        memoryPressureReason: "normal",
        source: "default",
        perAgentLimit: 8,
        running: 0,
        queued: 0,
      })
    }))

  test("reads the active scheduler state without reconfiguring it", () =>
    runtime.run(async () => {
      CortexConcurrency.configure(3)

      const response = await Server.App().request("/cortex/tasks/concurrency")

      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ configured: 3, effective: 3, source: "config" })
      expect(CortexConcurrency.globalStatus()).toMatchObject({ configured: 3, effective: 3, source: "config" })
    }))

  test("reports memory pressure as the effective admission limit", () =>
    runtime.run(async () => {
      CortexConcurrency.configure(3)
      CortexConcurrency.setMemoryProbeForTest(() => memorySnapshot(10, 9))

      const response = await Server.App().request("/cortex/tasks/concurrency")

      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({
        configured: 3,
        effective: 2,
        memoryPressureLimit: 2,
        memoryPressureReason: "critical_memory_pressure",
        source: "config",
      })
    }))
})

afterRuntimeTests(() => runtime.close())
