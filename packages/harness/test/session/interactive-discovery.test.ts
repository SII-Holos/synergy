import { expect, spyOn, test } from "bun:test"
import { Database } from "bun:sqlite"
import path from "node:path"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { SessionManager } from "../../src/session/manager"
import { SessionInbox } from "../../src/session/inbox"
import { Storage } from "../../src/storage/storage"
import { TransactionalStore } from "../../src/storage/transactional-store"
import { initializeSqliteEngine } from "../../src/storage/sqlite-engine"
import { StorageClosedError } from "../../src/storage/errors"
import { SessionLifecycle } from "../../src/session/lifecycle"
import { tmpdir } from "../support/fixture"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()

test("startup discovery reads typed records without walking every historical session", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const sessions = await Promise.all(Array.from({ length: 12 }, () => Session.create({ title: "History" })))
        const active = sessions[0]
        // Queued work is the unfinished-turn evidence startup reconciliation acts
        // on. The other eleven sessions have no messages and no inbox work, so
        // only this one is a candidate and the assertion stays discriminating.
        await SessionInbox.enqueueUser({
          sessionID: active.id,
          model: { providerID: "test", modelID: "test" },
          parts: [{ type: "text", text: "Queued" }],
        })
        const scan = spyOn(Storage, "scan")
        try {
          expect(await SessionLifecycle.listUnfinishedSessions(active.scope.id)).toEqual([active.id])
          expect(await SessionManager.listInterruptedCortexDelegations(active.scope.id)).toEqual([])
          expect(await SessionInbox.listRunnableSessions(active.scope.id)).toEqual([active.id])
          // Discovery must resolve typed records rather than enumerate the session
          // store: a `sessions`-rooted scan is only acceptable when it is bounded
          // to a single session (`["sessions", scopeID, sessionID, ...]`). A
          // prefix shorter than that walks the scope's whole history, which is the
          // regression this guards.
          const broadScans = scan.mock.calls.filter(([key]) => key[0] === "sessions" && key.length < 3)
          expect(broadScans).toHaveLength(0)
        } finally {
          scan.mockRestore()
          for (const session of sessions) await Session.remove(session.id)
        }
      },
    })
  }))

test("inbox recovery continues past a corrupt page and an unreadable owner", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "recovery.sqlite")
    const store = await TransactionalStore.open({ backend: "sqlite", filename, namespace: "recovery" })
    try {
      await store.transaction(async (tx) => {
        for (const id of ["ses_bad", "ses_bad_owner", "ses_healthy"]) {
          await tx.write(["sessions", "scope", id, "info"], { id, scope: { id: "scope" }, time: { created: 1 } })
        }
        for (let i = 0; i < 257; i++) {
          const id = `bad_${String(i).padStart(3, "0")}`
          await tx.write(["sessions", "scope", "ses_bad", "inbox", id], { id, mode: "task", status: "queued" })
        }
        for (const sessionID of ["ses_bad_owner", "ses_healthy"]) {
          await tx.write(["sessions", "scope", sessionID, "inbox", "valid"], {
            id: "valid",
            mode: "task",
            status: "queued",
          })
        }
      })
      initializeSqliteEngine()
      const database = new Database(filename)
      try {
        database.run(
          "UPDATE storage_records SET body='{' WHERE namespace='recovery' AND session_id='ses_bad' AND kind='inbox'",
        )
        database.run(
          "UPDATE storage_records SET body='z:invalid' WHERE namespace='recovery' AND session_id='ses_bad_owner' AND kind='session'",
        )
      } finally {
        database.close()
      }
      await Storage.provide({ store, artifactDirectory: tmp.path }, async () => {
        using scan = spyOn(Storage, "scan")
        expect(await SessionInbox.listRunnableSessions("scope")).toEqual(["ses_healthy"])
        expect(scan.mock.calls).toHaveLength(0)
        expect(await store.query({ kind: "session", sessionID: "ses_healthy" })).toHaveLength(1)
      })
    } finally {
      await store.close()
    }
  }))

test("inbox recovery propagates an unavailable store", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir()
    const store = await TransactionalStore.open({
      backend: "sqlite",
      namespace: "closed",
      filename: path.join(tmp.path, "closed.sqlite"),
    })
    await store.close()
    await expect(
      Storage.provide({ store, artifactDirectory: "." }, () => SessionInbox.listRunnableSessions()),
    ).rejects.toBeInstanceOf(StorageClosedError)
  }))

afterRuntimeTests(() => runtime.close())
