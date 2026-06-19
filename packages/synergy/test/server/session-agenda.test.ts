import { describe, expect, test } from "bun:test"
import { AgendaStore } from "../../src/agenda/store"
import { Identifier } from "../../src/id/id"
import { Instance } from "../../src/scope/instance"
import { Scope } from "../../src/scope"
import { Server } from "../../src/server/server"
import { Session } from "../../src/session"
import { StoragePath } from "../../src/storage/path"
import { Storage } from "../../src/storage/storage"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

type TestAgendaItemInput = {
  title: string
  sessionID?: string
  status?: "active" | "pending" | "paused" | "done" | "cancelled"
  wake?: boolean
  silent?: boolean
  global?: boolean
  nextRunAt?: number | null
}

function withProjectScope(fn: (scope: Scope) => Promise<void>) {
  return async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await Instance.provide({ scope, fn: async () => fn(scope) })
  }
}

async function createAgendaItem(input: TestAgendaItemInput) {
  const future = Date.now() + 86_400_000
  const item = await AgendaStore.create({
    title: input.title,
    prompt: "Run the scheduled test task.",
    triggers: [{ type: "at", at: future }],
    sessionID: input.sessionID,
    wake: input.wake ?? true,
    silent: input.silent ?? false,
    global: input.global ?? false,
    createdBy: "agent",
  })

  const storageScopeID = Identifier.asScopeID(input.global ? "global" : Instance.scope.id)
  await Storage.update(StoragePath.agendaItem(storageScopeID, item.id), (draft: any) => {
    if (input.status) draft.status = input.status
    if (input.nextRunAt === null) delete draft.state.nextRunAt
    else if (input.nextRunAt !== undefined) draft.state.nextRunAt = input.nextRunAt
  })

  return item
}

async function getSessionAgenda(sessionID: string, query = "") {
  const app = Server.App()
  const suffix = query ? `?${query}` : ""
  const response = await app.request(`/session/${sessionID}/agenda${suffix}`)
  const text = await response.text()
  const contentType = response.headers.get("content-type") ?? ""
  const body = contentType.includes("application/json") && text ? JSON.parse(text) : undefined
  return { response, body }
}

describe("GET /session/:sessionID/agenda", () => {
  test(
    "returns the session wakeup response shape",
    withProjectScope(async () => {
      const session = await Session.create({ title: "Agenda wakeups" })
      const item = await createAgendaItem({ title: "Morning check", sessionID: session.id })

      const { response, body } = await getSessionAgenda(session.id)

      expect(response.status).toBe(200)
      expect(body).toEqual({
        sessionID: session.id,
        count: 1,
        hasActiveAgenda: true,
        items: [
          {
            itemID: item.id,
            title: "Morning check",
            status: "active",
            nextRunAt: expect.any(Number),
            triggerTypes: ["at"],
            triggers: [{ type: "at" }],
            global: false,
          },
        ],
        offset: 0,
        limit: 6,
        total: 1,
        hasMore: false,
      })

      await Session.remove(session.id)
    }),
  )

  test(
    "returns an empty result when the session has no matching agenda items",
    withProjectScope(async () => {
      const session = await Session.create({ title: "No wakeups" })

      const { response, body } = await getSessionAgenda(session.id)

      expect(response.status).toBe(200)
      expect(body).toEqual({
        sessionID: session.id,
        count: 0,
        hasActiveAgenda: false,
        items: [],
        offset: 0,
        limit: 6,
        total: 0,
        hasMore: false,
      })

      await Session.remove(session.id)
    }),
  )

  test(
    "filters to agenda items that can wake the requested session",
    withProjectScope(async () => {
      const session = await Session.create({ title: "Target session" })
      const otherSession = await Session.create({ title: "Other session" })
      const future = Date.now() + 86_400_000
      const includedActive = await createAgendaItem({ title: "Active", sessionID: session.id, nextRunAt: future })
      const includedPending = await createAgendaItem({
        title: "Pending",
        sessionID: session.id,
        status: "pending",
        nextRunAt: future + 1_000,
      })
      const includedOpenEnded = await createAgendaItem({
        title: "Open ended",
        sessionID: session.id,
        nextRunAt: null,
      })
      const excludedPaused = await createAgendaItem({ title: "Paused", sessionID: session.id, status: "paused" })
      const excludedDone = await createAgendaItem({ title: "Done", sessionID: session.id, status: "done" })
      const excludedWakeFalse = await createAgendaItem({ title: "No wake", sessionID: session.id, wake: false })
      const excludedSilent = await createAgendaItem({ title: "Silent", sessionID: session.id, silent: true })
      const excludedOverdue = await createAgendaItem({
        title: "Overdue",
        sessionID: session.id,
        nextRunAt: Date.now() - 60_000,
      })
      const excludedOtherSession = await createAgendaItem({ title: "Other", sessionID: otherSession.id })

      const { response, body } = await getSessionAgenda(session.id)
      const ids = body.items.map((item: any) => item.itemID)

      expect(response.status).toBe(200)
      expect(ids).toEqual([includedActive.id, includedPending.id, includedOpenEnded.id])
      expect(ids).not.toContain(excludedPaused.id)
      expect(ids).not.toContain(excludedDone.id)
      expect(ids).not.toContain(excludedWakeFalse.id)
      expect(ids).not.toContain(excludedSilent.id)
      expect(ids).not.toContain(excludedOverdue.id)
      expect(ids).not.toContain(excludedOtherSession.id)
      expect(body.total).toBe(3)
      expect(body.hasActiveAgenda).toBe(true)

      await Session.remove(otherSession.id)
      await Session.remove(session.id)
    }),
  )

  test(
    "includes global agenda items only when they target the requested session",
    withProjectScope(async () => {
      const session = await Session.create({ title: "Global target" })
      const otherSession = await Session.create({ title: "Global other" })
      const localItem = await createAgendaItem({ title: "Local", sessionID: session.id })
      const globalItem = await createAgendaItem({ title: "Global", sessionID: session.id, global: true })
      const otherGlobalItem = await createAgendaItem({
        title: "Other global",
        sessionID: otherSession.id,
        global: true,
      })

      const { response, body } = await getSessionAgenda(session.id)
      const ids = body.items.map((item: any) => item.itemID)

      expect(response.status).toBe(200)
      expect(ids).toContain(localItem.id)
      expect(ids).toContain(globalItem.id)
      expect(ids).not.toContain(otherGlobalItem.id)
      expect(body.total).toBe(2)

      await Session.remove(otherSession.id)
      await Session.remove(session.id)
    }),
  )

  test(
    "sorts upcoming wakeups by nextRunAt ascending with open-ended items last",
    withProjectScope(async () => {
      const session = await Session.create({ title: "Sorted wakeups" })
      const base = Date.now() + 86_400_000
      const middle = await createAgendaItem({ title: "Middle", sessionID: session.id, nextRunAt: base + 2_000 })
      const earliest = await createAgendaItem({ title: "Earliest", sessionID: session.id, nextRunAt: base + 1_000 })
      const openEnded = await createAgendaItem({ title: "Open ended", sessionID: session.id, nextRunAt: null })
      const latest = await createAgendaItem({ title: "Latest", sessionID: session.id, nextRunAt: base + 3_000 })

      const { response, body } = await getSessionAgenda(session.id)

      expect(response.status).toBe(200)
      expect(body.items.map((item: any) => item.itemID)).toEqual([earliest.id, middle.id, latest.id, openEnded.id])

      await Session.remove(session.id)
    }),
  )

  test(
    "supports count-only and paginated queries",
    withProjectScope(async () => {
      const session = await Session.create({ title: "Paginated wakeups" })
      const base = Date.now() + 86_400_000
      const items = []
      for (let index = 0; index < 5; index++) {
        items.push(
          await createAgendaItem({
            title: `Wakeup ${index}`,
            sessionID: session.id,
            nextRunAt: base + index * 1_000,
          }),
        )
      }

      const countOnly = await getSessionAgenda(session.id, "limit=0")
      expect(countOnly.response.status).toBe(200)
      expect(countOnly.body.items).toEqual([])
      expect(countOnly.body.count).toBe(5)
      expect(countOnly.body.total).toBe(5)
      expect(countOnly.body.hasActiveAgenda).toBe(true)
      expect(countOnly.body.hasMore).toBe(true)

      const page = await getSessionAgenda(session.id, "limit=2&offset=2")
      expect(page.response.status).toBe(200)
      expect(page.body.items.map((item: any) => item.itemID)).toEqual([items[2].id, items[3].id])
      expect(page.body.offset).toBe(2)
      expect(page.body.limit).toBe(2)
      expect(page.body.total).toBe(5)
      expect(page.body.hasMore).toBe(true)

      await Session.remove(session.id)
    }),
  )

  test(
    "validates query parameters and missing sessions",
    withProjectScope(async () => {
      const session = await Session.create({ title: "Validation" })

      const negativeOffset = await getSessionAgenda(session.id, "offset=-1")
      const oversizedLimit = await getSessionAgenda(session.id, "limit=51")
      const missingSession = await getSessionAgenda("ses_missing_session_agenda")

      expect(negativeOffset.response.status).toBe(400)
      expect(oversizedLimit.response.status).toBe(400)
      expect(missingSession.response.status).toBe(404)

      await Session.remove(session.id)
    }),
  )
})
