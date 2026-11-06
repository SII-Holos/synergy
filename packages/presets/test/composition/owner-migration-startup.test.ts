import { composeWithExperiments } from "../support/selected-components"
import { expect, spyOn, test } from "bun:test"
import { RuntimeComponents } from "@ericsanchezok/synergy-harness/lifecycle"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { runtimeHome } from "@ericsanchezok/synergy-harness/test/support/runtime-home"
import { localRuntime } from "@ericsanchezok/synergy-local-runtime/component"
import { note } from "@ericsanchezok/synergy-note/component"
import { blueprint } from "@ericsanchezok/synergy-blueprint/component"
import { lattice } from "@ericsanchezok/synergy-lattice/component"
import { lightLoop } from "@ericsanchezok/synergy-light-loop/component"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionHistory } from "@ericsanchezok/synergy-harness/session/history"
import { MessageV2 } from "@ericsanchezok/synergy-harness/session/message-v2"
import { Identifier } from "@ericsanchezok/synergy-harness/id/id"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"

const cases = [
  { domain: "blueprint-session", id: "20261012-blueprint-session-owner", kind: "plan", legacy: { planMode: true } },
  {
    domain: "light-loop-session",
    id: "20261012-light-loop-session-owner",
    kind: "lightloop",
    legacy: { lightLoop: { active: true, taskDescription: "Retained task" } },
  },
  {
    domain: "lattice-session",
    id: "20261012-lattice-session-owner",
    kind: "lattice",
    legacy: { lattice: { runID: "retained", mode: "auto" } },
  },
] as const
const within = <T>(fn: () => Promise<T>) => ScopeContext.provide({ scope: Scope.home(), fn })
function open(home: string, selected: boolean) {
  const composition = composeWithExperiments([
    localRuntime({ workers: false, environment: false }),
    ...(selected ? [note(), blueprint(), lattice(), lightLoop()] : []),
  ])
  return testRuntime({ home, composition: { register: composition.register } })
}

for (const completed of [false, true])
  test(`optional workflow startup leaves cold history untouched with ${completed ? "completed" : "pending"} released receipts`, async () => {
    await using home = await runtimeHome()
    const owners: Array<{
      sessionID: string
      messageID: string
      kind: (typeof cases)[number]["kind"]
      domain: string
      id: string
    }> = []
    {
      await using runtime = await open(home.host.home, false)
      await runtime.run(() =>
        within(async () => {
          await Storage.write(["meta", "migration", "log-lattice"], { "20260722-lattice-v2-reset": 42 })
          for (const entry of cases) {
            const session = await Session.create({ title: "Cold optional workflow" })
            const messageID = Identifier.ascending("message")
            owners.push({ ...entry, sessionID: session.id, messageID })
            await Storage.write(["sessions", "home", session.id, "info"], {
              ...session,
              ...entry.legacy,
              futureOwner: { kept: true },
            })
            await Storage.write(["sessions", "home", session.id, "messages", messageID, "info"], {
              id: messageID,
              sessionID: session.id,
              role: "user",
              agent: "general",
              model: { providerID: "fixture", modelID: "fixture" },
              time: { created: 1 },
              origin: { type: "user" },
              isRoot: true,
              metadata: { workflowMode: entry.kind, workflowModeAgent: "general", future: "retained" },
            })
            await Storage.transaction(async () => {
              for (let part = 0; part < 180; part++) {
                const id = Identifier.ascending("part")
                await Storage.write(["sessions", "home", session.id, "messages", messageID, "parts", id], {
                  id,
                  messageID,
                  sessionID: session.id,
                  type: "text",
                  text: "Retained history ".repeat(100),
                })
              }
            })
            await SessionHistory.timelinePage({ sessionID: session.id })
            if (completed) await Storage.write(["meta", "migration", `log-${entry.domain}`], { [entry.id]: 42 })
          }
        }),
      )
    }
    using list = spyOn(Storage, "list")
    using query = spyOn(Storage, "query")
    using reads = spyOn(Storage, "readMany")
    await using runtime = await open(home.host.home, true)
    expect(list.mock.calls.filter(([key]) => key[0] === "sessions")).toEqual([])
    expect(query.mock.calls.filter(([input]) => ["session", "message", "part"].includes(input.kind ?? ""))).toEqual([])
    expect(reads.mock.calls.flatMap(([keys]) => keys.filter((key) => key[0] === "sessions"))).toEqual([])
    await runtime.run(() =>
      within(async () => {
        for (const owner of owners) {
          reads.mockClear()
          const session = await Session.get(owner.sessionID)
          expect(session.workflow?.kind).toBe(owner.kind)
          expect(reads.mock.calls.flatMap(([keys]) => keys.filter((key) => key[3] === "messages"))).toEqual([])
          expect(await Storage.read<unknown>(["sessions", "home", owner.sessionID, "info"])).toHaveProperty(
            "futureOwner",
            {
              kept: true,
            },
          )
          const message = await MessageV2.get({ sessionID: owner.sessionID, messageID: owner.messageID })
          expect(message.info.metadata).toMatchObject({ workflow: owner.kind, workflowVersion: 1, future: "retained" })
          expect(message.info.metadata).not.toHaveProperty("workflowMode")
          expect(message.parts).toHaveLength(180)
          const page = await SessionHistory.timelinePage({ sessionID: owner.sessionID })
          expect(page.items[0].info.metadata).toEqual(message.info.metadata)
          const details = await SessionHistory.messageDetails({
            sessionID: owner.sessionID,
            messageID: owner.messageID,
            version: page.items[0].content.version,
          })
          expect(details.info.metadata).toEqual(message.info.metadata)
          const receipt = await Storage.read<unknown>([
            "sessions",
            "home",
            owner.sessionID,
            "migrations",
            owner.domain,
            owner.id,
          ])
          await Session.get(owner.sessionID)
          expect(
            await Storage.read<unknown>(["sessions", "home", owner.sessionID, "migrations", owner.domain, owner.id]),
          ).toEqual(receipt)
        }
      }),
    )
  }, 30_000)
