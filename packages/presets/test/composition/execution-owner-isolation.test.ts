import { composeWithExperiments } from "../support/selected-components"
import { expect, spyOn, test } from "bun:test"
import { RuntimeComponents, type RuntimeComponent } from "@ericsanchezok/synergy-harness/lifecycle"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { runtimeHome } from "@ericsanchezok/synergy-harness/test/support/runtime-home"
import { localRuntime } from "@ericsanchezok/synergy-local-runtime/component"
import { note } from "@ericsanchezok/synergy-note/component"
import { blueprint } from "@ericsanchezok/synergy-blueprint/component"
import { lattice } from "@ericsanchezok/synergy-lattice/component"
import { lightLoop } from "@ericsanchezok/synergy-light-loop/component"
import { agenda } from "@ericsanchezok/synergy-agenda/component"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionInbox } from "@ericsanchezok/synergy-harness/session/inbox"
import { SessionDrive } from "@ericsanchezok/synergy-harness/session/drive"
import { SessionManager } from "@ericsanchezok/synergy-harness/session/manager"
import { ContinuationKernel } from "@ericsanchezok/synergy-harness/session/continuation-kernel"
import { Identifier } from "@ericsanchezok/synergy-harness/id/id"
import { PrimaryAgentIdentity } from "@ericsanchezok/synergy-harness/agent/primary-identity"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"

const owners = () => [note(), blueprint(), lattice(), lightLoop(), agenda()]
const model = { providerID: "fixture", modelID: "fixture" }
function open(home: string, components: RuntimeComponent[]) {
  const composition = composeWithExperiments([localRuntime({ workers: false, environment: false }), ...components])
  return testRuntime({ home, composition: { register: composition.register } })
}
function within<T>(fn: () => Promise<T>) {
  return ScopeContext.provide({ scope: Scope.home(), fn })
}

async function terminal(sessionID: string, metadata?: Record<string, unknown>) {
  const root = await Session.updateMessage({
    id: Identifier.ascending("message"),
    role: "user",
    sessionID,
    time: { created: Date.now() },
    agent: PrimaryAgentIdentity.names.general,
    model,
    isRoot: true,
    origin: { type: "user" },
    metadata,
  })
  await Session.updatePart({
    id: Identifier.ascending("part"),
    sessionID,
    messageID: root.id,
    type: "text",
    text: "Original request",
  })
  await finishRoot(sessionID, root.id)
  return root
}

async function finishRoot(sessionID: string, rootID: string) {
  await Session.updateMessage({
    id: Identifier.ascending("message"),
    role: "assistant",
    sessionID,
    parentID: rootID,
    rootID,
    time: { created: Date.now(), completed: Date.now() },
    agent: PrimaryAgentIdentity.names.general,
    mode: PrimaryAgentIdentity.names.general,
    providerID: model.providerID,
    modelID: model.modelID,
    path: { cwd: null, root: null },
    finish: "stop",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  })
}

for (const source of ["agenda", "light_loop_continuation", "lattice_continuation"]) {
  test(`retained ${source} inbox work stays dormant without its owner and survives reinstall`, async () => {
    await using home = await runtimeHome()
    let sessionID = ""
    const stored: SessionInbox.StoredItem[] = []
    for (const selection of ["seed", "core", "installed"] as const) {
      await using runtime = await open(home.host.home, selection === "core" ? [] : owners())
      await runtime.run(() =>
        within(async () => {
          if (selection === "seed") {
            sessionID = (await Session.create({ title: "Retained component delivery" })).id
            for (const mode of ["task", "steer", "context"] as const) {
              const item = await SessionInbox.deliver({
                sessionID,
                mode,
                message: {
                  role: "user",
                  model,
                  origin: { type: "system" },
                  metadata: { source },
                  parts: [{ type: "text", text: `${source}:${mode}`, origin: "system" }],
                },
              })
              stored.push(await SessionInbox.getStored(sessionID, item.itemID))
            }
            return
          }
          if (selection === "core") {
            expect(await SessionInbox.peekReady(sessionID)).toEqual([])
            expect(await SessionInbox.peekTask(sessionID)).toBeUndefined()
            expect(await SessionInbox.peekSteer(sessionID)).toEqual([])
            expect(await SessionInbox.peekContext(sessionID)).toEqual([])
            expect(await SessionInbox.listRunnableSessions()).not.toContain(sessionID)
            using wake = spyOn(SessionManager, "scheduleWake").mockImplementation(() => {})
            expect(await SessionDrive.request(sessionID, "owner-removed")).toBe(false)
            await expect(SessionDrive.request(sessionID, "owner-removed-force", { force: true })).rejects.toMatchObject(
              { name: "SessionExecutionOwnerUnavailableError" },
            )
            expect(wake).not.toHaveBeenCalled()
            expect(await SessionInbox.materializeItem(stored[0]!)).toBeUndefined()
            const manual = await SessionInbox.enqueueUser({
              sessionID,
              model,
              parts: [{ type: "text", text: "New user request" }],
            })
            expect((await SessionInbox.peekTask(sessionID))?.id).toBe(manual.id)
            expect(await SessionInbox.materializeNextTask(sessionID)).toMatchObject({
              status: "materialized",
              itemID: manual.id,
            })
            expect(
              (await Session.messages({ sessionID })).some((message) => message.info.id === manual.messageID),
            ).toBe(true)
          } else {
            expect((await SessionInbox.peekReady(sessionID)).map((item) => item.id)).toEqual([stored[0]!.id])
            expect((await SessionInbox.peekTask(sessionID))?.id).toBe(stored[0]?.id)
            expect(await SessionInbox.peekSteer(sessionID)).toEqual([])
            expect(await SessionInbox.peekContext(sessionID)).toEqual([])
          }
          for (const item of stored) expect(await SessionInbox.getStored(sessionID, item.id)).toEqual(item)
          if (selection === "installed") {
            await finishRoot(sessionID, (await SessionInbox.latestRootID(sessionID))!)
            expect(await SessionInbox.materializeNextTask(sessionID)).toMatchObject({
              status: "materialized",
              itemID: stored[0]!.id,
            })
            expect((await SessionInbox.peekReady(sessionID)).map((item) => item.id)).toEqual(
              stored.slice(1).map((item) => item.id),
            )
            for (const item of stored.slice(1)) expect(await SessionInbox.getStored(sessionID, item.id)).toEqual(item)
          }
        }),
      )
    }
  }, 30_000)
}

for (const kind of ["lightloop", "lattice"] as const) {
  test(`a retained ${kind} binding does not permit automatic or forced resumption`, async () => {
    await using home = await runtimeHome()
    let sessionID = ""
    let raw: Record<string, unknown> = {}
    {
      await using runtime = await open(home.host.home, owners())
      await runtime.run(() =>
        within(async () => {
          sessionID = (await Session.create({ title: "Retained workflow" })).id
          await terminal(sessionID)
          const key = ["sessions", "home", sessionID, "info"]
          raw = {
            ...(await Storage.read<Record<string, unknown>>(key)),
            workflow: { kind, instructions: "Retained work", runID: "lat_retained" },
          }
          await Storage.write(key, raw)
        }),
      )
    }
    await using runtime = await open(home.host.home, [])
    await runtime.run(() =>
      within(async () => {
        let calls = 0
        ContinuationKernel.register({
          id: "core-probe",
          priority: 1,
          async handle() {
            calls++
            return { kind: "handled" }
          },
        })
        using wake = spyOn(SessionManager, "scheduleWake").mockImplementation(() => {})
        expect(await ContinuationKernel.propose(sessionID)).toBeUndefined()
        expect(calls).toBe(0)
        await expect(SessionDrive.request(sessionID, "owner-removed", { force: true })).rejects.toMatchObject({
          name: "SessionExecutionOwnerUnavailableError",
        })
        expect(wake).not.toHaveBeenCalled()
        const manual = await SessionInbox.enqueueUser({
          sessionID,
          model,
          parts: [{ type: "text", text: "Independent new request" }],
        })
        expect(await SessionDrive.request(sessionID, "human-input")).toBe(true)
        expect((await SessionInbox.peekTask(sessionID))?.id).toBe(manual.id)
        expect((await Storage.read<Record<string, unknown>>(["sessions", "home", sessionID, "info"])).workflow).toEqual(
          raw.workflow,
        )
      }),
    )
  }, 30_000)
}

for (const source of ["agenda", "light_loop_continuation", "lattice_continuation"]) {
  test(`already materialized ${source} control cannot restart an ordinary historical root`, async () => {
    await using home = await runtimeHome()
    let sessionID = ""
    let before: Awaited<ReturnType<typeof Session.messages>> = []
    {
      await using runtime = await open(home.host.home, owners())
      await runtime.run(() =>
        within(async () => {
          sessionID = (await Session.create({ title: "Retained control" })).id
          const root = await terminal(sessionID)
          const delivered = await SessionInbox.deliver({
            sessionID,
            mode: "steer",
            message: {
              role: "user",
              metadata: { source },
              parts: [{ type: "text", text: "Resume optional work", origin: "system" }],
            },
          })
          await SessionInbox.materializeItem(await SessionInbox.getStored(sessionID, delivered.itemID), root.id)
          before = await Session.messages({ sessionID })
        }),
      )
    }
    await using runtime = await open(home.host.home, [])
    await runtime.run(() =>
      within(async () => {
        using wake = spyOn(SessionManager, "scheduleWake").mockImplementation(() => {})
        expect(await ContinuationKernel.passesSharedGate(sessionID)).toBeUndefined()
        await expect(SessionDrive.request(sessionID, "retained-control", { force: true })).rejects.toMatchObject({
          name: "SessionExecutionOwnerUnavailableError",
        })
        expect(wake).not.toHaveBeenCalled()
        expect(await Session.messages({ sessionID })).toEqual(before)
      }),
    )
  }, 30_000)
}
