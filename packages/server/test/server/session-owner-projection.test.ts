import { expect, test } from "bun:test"
import { z } from "zod"
import { RuntimeComponents } from "@ericsanchezok/synergy-harness/lifecycle"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { runtimeHome } from "@ericsanchezok/synergy-harness/test/support/runtime-home"
import { localRuntime } from "@ericsanchezok/synergy-local-runtime/component"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionEvent } from "@ericsanchezok/synergy-harness/session/event"
import { SessionSchemaRegistry } from "@ericsanchezok/synergy-harness/session/schema-registry"
import { WorkflowKindRegistry } from "@ericsanchezok/synergy-harness/session/workflow-kind-registry"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { Bus } from "@ericsanchezok/synergy-harness/bus"
import { Server } from "../../src/server/server"
import { server } from "../../src/component"

function owner(id: string) {
  return {
    id,
    apiVersion: 1 as const,
    version: "1.0.0",
    register() {
      WorkflowKindRegistry.register({
        id,
        conflicts: [],
        schema: z.object({ kind: z.literal(id), instructions: z.string() }),
        async enable() {},
      })
      if (id === "fixture-owner") {
        SessionSchemaRegistry.register(id, {
          shape: {
            blueprint: z.object({ loopID: z.string(), loopRole: z.literal("execution") }).optional(),
          },
          navIdentity: (session) => ({ blueprint: session.blueprint }),
        })
      } else {
        SessionSchemaRegistry.register(id, { shape: { otherOwner: z.string().optional() } })
      }
    },
  }
}

test("Session HTTP, events and navigation hide absent owners and restore their preserved records on reinstall", async () => {
  await using home = await runtimeHome()
  const blueprint = { loopID: "retained-loop", loopRole: "execution", future: { checkpoint: [1, 2] } }
  const workflow = { kind: "fixture-owner", instructions: "Retained instructions", future: { revision: 9 } }
  let sessionID = ""
  for (const selection of ["fixture-owner", undefined, "fixture-other", "fixture-owner"]) {
    await using runtime = await testRuntime({
      home: home.host.home,
      composition: RuntimeComponents.compose([
        localRuntime({ workers: false, environment: false }),
        server(),
        ...(selection ? [owner(selection)] : []),
      ]),
    })
    await runtime.run(() =>
      ScopeContext.provide({
        scope: Scope.home(),
        fn: async () => {
          if (!sessionID) {
            sessionID = (await Session.create({ title: "Retained owner session" })).id
            const key = ["sessions", "home", sessionID, "info"]
            await Storage.write(key, {
              ...(await Storage.read<Record<string, unknown>>(key)),
              blueprint,
              workflow,
              futureOwner: { keep: true },
            })
            await Session.update(sessionID, (session) => {
              session.title = "Retained owner session"
            })
          }
          const installed = selection === "fixture-owner"
          const assertPublic = (info: Record<string, unknown>) => {
            expect(info.id).toBe(sessionID)
            expect(info).not.toHaveProperty("futureOwner")
            if (installed) {
              expect(info.blueprint).toEqual({ loopID: blueprint.loopID, loopRole: "execution" })
              expect(info.workflow).toEqual({ kind: workflow.kind, instructions: workflow.instructions })
            } else {
              expect(info).not.toHaveProperty("blueprint")
              expect(info).not.toHaveProperty("workflow")
            }
          }
          const request = (url: string, init?: RequestInit) =>
            Server.App().request(url + (url.includes("?") ? "&" : "?") + "scopeID=home", init)
          const detail = await request(`/session/${sessionID}`)
          expect(detail.status).toBe(200)
          assertPublic(await detail.json())
          for (const url of ["/session", "/session?search=Retained"]) {
            const response = await request(url)
            expect(response.status).toBe(200)
            const page = (await response.json()) as { data: Record<string, unknown>[] }
            expect(page.data).toHaveLength(1)
            assertPublic(page.data[0]!)
          }
          for (const url of ["/scope/bootstrap-core", "/scope/bootstrap"]) {
            const response = await request(url)
            expect(response.status).toBe(200)
            const body = (await response.json()) as { sessions: { data: Record<string, unknown>[] } }
            expect(body.sessions.data).toHaveLength(1)
            assertPublic(body.sessions.data[0]!)
          }
          for (const url of ["/session/index", "/global/recent"]) {
            const response = await request(url)
            expect(response.status).toBe(200)
            const page = (await response.json()) as { items: Record<string, unknown>[] }
            expect(page.items).toHaveLength(1)
            expect(page.items[0]?.id).toBe(sessionID)
            expect(page.items[0]?.workflow).toEqual(installed ? { kind: workflow.kind, active: false } : undefined)
            expect(page.items[0]?.blueprint).toEqual(
              installed ? { loopID: blueprint.loopID, loopRole: "execution" } : undefined,
            )
          }
          const event = Promise.withResolvers<Record<string, unknown>>()
          const unsubscribe = Bus.subscribe(SessionEvent.Updated, ({ properties }) => event.resolve(properties.info))
          try {
            const response = await request(`/session/${sessionID}`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ title: `Retained owner session ${selection ?? "core"}` }),
            })
            expect(response.status).toBe(200)
            assertPublic(await response.json())
            assertPublic(await event.promise)
          } finally {
            unsubscribe()
          }
          const raw = await Storage.read<Record<string, unknown>>(["sessions", "home", sessionID, "info"])
          expect(raw.blueprint).toEqual(blueprint)
          expect(raw.workflow).toEqual(workflow)
          expect(raw.futureOwner).toEqual({ keep: true })
          expect(await Session.get(sessionID)).toMatchObject({ blueprint, workflow })
        },
      }),
    )
  }
}, 30_000)
