import { describe, expect, spyOn, test } from "bun:test"
import { Identifier } from "../../src/id/id"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { SessionHistoryDisplay as Display } from "../../src/session/history-display"
import { MessageV2 } from "../../src/session/message-v2"
import { Storage } from "../../src/storage/storage"
import { StoragePath } from "../../src/storage/path"
import { SqliteDriver } from "../../src/storage/sqlite-driver"
import { PostgresDriver } from "../../src/storage/postgres-driver"
import type { SqlConnection, SqlDriver, SqlTransactionOptions } from "../../src/storage/sql-contract"
import { StoreTransaction } from "../../src/storage/transactional-store"
import { withStorageQueueOptions } from "../../src/storage/queue"
import { storageTestBackends } from "../support/storage-backends"
import { testRuntime } from "../support/runtime"

async function guarded<T>(pending: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Display barrier did not settle")), 5_000)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

function observeDriver(backend: "sqlite" | "postgres", observe: (options: SqlTransactionOptions | undefined) => void) {
  const driver: SqlDriver = backend === "sqlite" ? SqliteDriver.prototype : PostgresDriver.prototype
  const transaction = driver.transaction
  return spyOn(driver, "transaction").mockImplementation(function <T>(
    this: SqlDriver,
    body: (connection: SqlConnection) => Promise<T>,
    options?: SqlTransactionOptions,
  ): Promise<T> {
    observe(options)
    return transaction.call(this, body, options) as Promise<T>
  })
}

async function seed(count = 2) {
  const session = await Session.create({ title: "Display isolation" })
  const scopeID = Identifier.asScopeID(session.scope.id)
  const sessionID = Identifier.asSessionID(session.id)
  const messages = Array.from({ length: count }, (_, index) => {
    const info: MessageV2.User = {
      id: Identifier.ascending("message"),
      sessionID,
      role: "user",
      agent: "test-agent",
      model: { providerID: "test", modelID: "test" },
      time: { created: index + 1 },
      isRoot: true,
      visible: true,
    }
    const part: MessageV2.TextPart = {
      id: Identifier.ascending("part"),
      messageID: info.id,
      sessionID,
      type: "text",
      text: `canonical ${index}`,
    }
    return { info, part }
  })
  const infoKey = (info: MessageV2.Info) => StoragePath.messageInfo(scopeID, sessionID, Identifier.asMessageID(info.id))
  const partKey = (part: MessageV2.Part) =>
    StoragePath.messagePart(scopeID, sessionID, Identifier.asMessageID(part.messageID), Identifier.asPartID(part.id))
  const stateKey = (messageID: string) => ["sessions", scopeID, sessionID, "display_parts_state", messageID]
  await Storage.transaction((tx) =>
    tx.writeMany(
      messages.flatMap(({ info, part }) => [
        { key: infoKey(info), value: info },
        { key: partKey(part), value: part },
      ]),
    ),
  )
  const batch = () =>
    Display.partPages({ sessionID, messageIDs: messages.map(({ info }) => info.id) }, async () => undefined, scopeID)
  return { sessionID, scopeID, messages, infoKey, partKey, stateKey, batch }
}

for (const backend of storageTestBackends()) {
  describe(`${backend} display transaction isolation`, () => {
    async function run(body: () => Promise<void>) {
      await using runtime = await testRuntime({
        postgres: backend === "postgres" ? process.env.SYNERGY_TEST_POSTGRES_URL : undefined,
      })
      await runtime.run(() => ScopeContext.provide({ scope: Scope.home(), fn: body }))
    }

    ;(test("an ambient writer prepares its own wave while an external wave waits for that writer", () =>
      run(async () => {
        const fixture = await seed(1)
        const entered = Promise.withResolvers<void>()
        const queued = Promise.withResolvers<void>()
        const resume = Promise.withResolvers<void>()
        const writer = Storage.transaction(async () => {
          entered.resolve()
          await resume.promise
          await guarded(Display.prepareWindow(fixture.scopeID, fixture.sessionID, [fixture.messages[0].info]))
          expect(await Display.header(fixture.scopeID, fixture.sessionID, fixture.messages[0].info.id)).toBeDefined()
        })
        void writer.catch(entered.reject)
        let external: Promise<void> | undefined
        try {
          await guarded(entered.promise)
          external = withStorageQueueOptions({ onWait: (waiting) => waiting && queued.resolve() }, () =>
            Display.prepareWindow(fixture.scopeID, fixture.sessionID, [fixture.messages[0].info]),
          )
          void external.catch(queued.reject)
          await guarded(queued.promise)
          resume.resolve()
          await guarded(writer)
          await guarded(external)
        } finally {
          resume.resolve()
          await Promise.allSettled([writer, external])
        }
      })),
      test("an external caller cannot report success from an ambient wave that rolls back", () =>
        run(async () => {
          const fixture = await seed(1)
          const entered = Promise.withResolvers<void>()
          const queued = Promise.withResolvers<void>()
          const release = Promise.withResolvers<void>()
          let externalSettled = false
          const writer = Storage.transaction(async () => {
            await Display.prepareWindow(fixture.scopeID, fixture.sessionID, [fixture.messages[0].info])
            entered.resolve()
            await release.promise
            throw new Error("rollback parent")
          })
          void writer.catch(entered.reject)
          let external: Promise<void> | undefined
          try {
            await guarded(entered.promise)
            external = withStorageQueueOptions({ onWait: (waiting) => waiting && queued.resolve() }, () =>
              Display.prepareWindow(fixture.scopeID, fixture.sessionID, [fixture.messages[0].info]),
            ).then(() => {
              externalSettled = true
              queued.resolve()
            })
            void external.catch(queued.reject)
            await guarded(queued.promise)
            expect(externalSettled).toBe(false)
          } finally {
            release.resolve()
            await Promise.allSettled([writer, external])
          }
          await expect(writer).rejects.toThrow("rollback parent")
          await expect(external!).resolves.toBeUndefined()
          expect(await Display.header(fixture.scopeID, fixture.sessionID, fixture.messages[0].info.id)).toBeDefined()
        })),
      test("writer admission rereads canonical headers and projection predecessors instead of stale input", () =>
        run(async () => {
          const fixture = await seed(3)
          const infos = fixture.messages.map(({ info }) => info)
          const updated = { ...infos[0], time: { created: 100 }, isRoot: false }
          const entered = Promise.withResolvers<void>()
          const queued = Promise.withResolvers<void>()
          const release = Promise.withResolvers<void>()
          const writer = Storage.transaction(async () => {
            await Storage.write(fixture.infoKey(updated), updated)
            await Display.messageWritten(fixture.scopeID, updated)
            await Storage.remove(fixture.infoKey(infos[1]))
            await Display.messageRemoved(fixture.scopeID, fixture.sessionID, infos[1].id)
            entered.resolve()
            await release.promise
          })
          void writer.catch(entered.reject)
          let external: Promise<void> | undefined
          try {
            await guarded(entered.promise)
            external = withStorageQueueOptions({ onWait: (waiting) => waiting && queued.resolve() }, () =>
              Display.prepareWindow(fixture.scopeID, fixture.sessionID, infos),
            )
            void external.catch(queued.reject)
            await guarded(queued.promise)
            release.resolve()
            await guarded(writer)
            await guarded(external)
            expect((await Display.header(fixture.scopeID, fixture.sessionID, infos[0].id))?.info).toEqual(updated)
            expect(await Display.header(fixture.scopeID, fixture.sessionID, infos[1].id)).toBeUndefined()
            expect(await Display.header(fixture.scopeID, fixture.sessionID, infos[2].id)).toBeDefined()
            expect(
              await Storage.readMany([
                StoragePath.sessionDisplayTimeline(
                  fixture.scopeID,
                  fixture.sessionID,
                  MessageV2.messageOrderMarker(infos[0]),
                ),
              ]),
            ).toEqual([undefined])
          } finally {
            release.resolve()
            await Promise.allSettled([writer, external])
          }
        })),
      test("a warm batch reads committed pages without writer admission while a writer holds uncommitted changes", () =>
        run(async () => {
          const fixture = await seed()
          const committed = await fixture.batch()
          let writers = 0
          let snapshots = 0
          using observed = observeDriver(backend, (options) => {
            if (!options?.readOnly) writers++
            else if (!options.singleStatement) snapshots++
          })
          expect(await fixture.batch()).toEqual(committed)
          expect(writers).toBe(0)
          expect(snapshots).toBe(1)
          observed[Symbol.dispose]()
          const entered = Promise.withResolvers<void>()
          const release = Promise.withResolvers<void>()
          const writer = Storage.transaction(async () => {
            for (const { part } of fixture.messages) {
              const updated = { ...part, text: "uncommitted part" }
              await Storage.write(fixture.partKey(part), updated)
              await Display.partWritten(fixture.scopeID, updated)
            }
            const local = await fixture.batch()
            expect(local).not.toEqual(committed)
            entered.resolve()
            await release.promise
          })
          void writer.catch(entered.reject)
          let pages: ReturnType<typeof fixture.batch> | undefined
          try {
            await guarded(entered.promise)
            pages = fixture.batch()
            expect(await guarded(pages)).toEqual(committed)
          } finally {
            release.resolve()
            await Promise.allSettled([writer, pages])
          }
          expect(await fixture.batch()).not.toEqual(committed)
        })),
      test("warm readiness and every page share one snapshot across a concurrent canonical update", () =>
        run(async () => {
          const fixture = await seed()
          const committed = await fixture.batch()
          const query = Storage.query
          const firstPageRead = Promise.withResolvers<void>()
          const resumePages = Promise.withResolvers<void>()
          const publicationQueued = Promise.withResolvers<"queued">()
          let paused = false
          using barrier = spyOn(Storage, "query").mockImplementation(async <T>(input: Parameters<typeof query>[0]) => {
            const rows = await query<T>(input)
            if (!paused && input.kind === "display_part") {
              paused = true
              firstPageRead.resolve()
              await resumePages.promise
            }
            return rows
          })
          const pages = fixture.batch()
          void pages.catch(firstPageRead.reject)
          let publication: Promise<void> | undefined
          try {
            await guarded(firstPageRead.promise)
            publication = withStorageQueueOptions(
              { onWait: (waiting) => waiting && publicationQueued.resolve("queued") },
              () =>
                Storage.current().store.transaction(async (tx) => {
                  for (const { part } of fixture.messages) {
                    const updated = { ...part, text: "later commit" }
                    await tx.write(fixture.partKey(part), updated)
                    await tx.write(
                      StoragePath.sessionDisplayPart(fixture.scopeID, fixture.sessionID, part.messageID, part.id),
                      Display.summarizePart(updated),
                    )
                  }
                }),
            )
            const admission = await guarded(
              Promise.race([publication.then(() => "committed" as const), publicationQueued.promise]),
            )
            expect(admission).toBe("committed")
            resumePages.resolve()
            expect(await guarded(pages)).toEqual(committed)
          } finally {
            resumePages.resolve()
            await Promise.allSettled([pages, publication])
          }
          barrier[Symbol.dispose]()
          expect(await fixture.batch()).not.toEqual(committed)
        })),
      test("ambient snapshots stay read-only on cold pages and ambient writers see and roll back their own projection", () =>
        run(async () => {
          const fixture = await seed()
          await expect(Storage.snapshot(() => fixture.batch())).rejects.toThrow("read-only snapshot")
          await expect(
            Storage.transaction(async () => {
              const first = fixture.messages[0].part
              const updated = { ...first, text: "parent-local part" }
              await Storage.write(fixture.partKey(first), updated)
              const pages = await fixture.batch()
              expect(pages[first.messageID].items[0]).toEqual(Display.summarizePart(updated))
              throw new Error("rollback cold pages")
            }),
          ).rejects.toThrow("rollback cold pages")
          expect(
            await Storage.query({ kind: "display_part", scopeID: fixture.scopeID, sessionID: fixture.sessionID }),
          ).toEqual([])
          expect(await Storage.readMany(fixture.messages.map(({ info }) => fixture.stateKey(info.id)))).toEqual([
            undefined,
            undefined,
          ])
          let writers = 0
          using observed = observeDriver(backend, (options) => {
            if (!options?.readOnly) writers++
          })
          const pages = await fixture.batch()
          expect(writers).toBe(1)
          for (const { part } of fixture.messages)
            expect(pages[part.messageID].items[0]).toEqual(Display.summarizePart(part))
        })),
      test("a failure on the second cold message rolls back the entire batch and permits a complete retry", () =>
        run(async () => {
          const fixture = await seed()
          const writeMany = StoreTransaction.prototype.writeMany
          let writes = 0
          using failure = spyOn(StoreTransaction.prototype, "writeMany").mockImplementation(async function (
            this: StoreTransaction,
            entries,
          ) {
            await writeMany.call(this, entries)
            if (entries.some(({ key }) => key[3] === "display_part") && ++writes === 2)
              throw new Error("second cold message failed")
          })
          await expect(fixture.batch()).rejects.toThrow("second cold message failed")
          expect(
            await Storage.query({ kind: "display_part", scopeID: fixture.scopeID, sessionID: fixture.sessionID }),
          ).toEqual([])
          expect(await Storage.readMany(fixture.messages.map(({ info }) => fixture.stateKey(info.id)))).toEqual([
            undefined,
            undefined,
          ])
          failure[Symbol.dispose]()
          const pages = await fixture.batch()
          for (const { part } of fixture.messages)
            expect(pages[part.messageID].items[0]).toEqual(Display.summarizePart(part))
        })),
      test("window registry isolation keeps identical owner identities independent across runtimes", async () => {
        await using first = await testRuntime({
          postgres: backend === "postgres" ? process.env.SYNERGY_TEST_POSTGRES_URL : undefined,
        })
        await using second = await testRuntime({
          postgres: backend === "postgres" ? process.env.SYNERGY_TEST_POSTGRES_URL : undefined,
        })
        const fixture = await first.run(() => ScopeContext.provide({ scope: Scope.home(), fn: () => seed(1) }))
        await second.run(async () => {
          await Storage.write(StoragePath.sessionInfo(fixture.scopeID, fixture.sessionID), { id: fixture.sessionID })
          await Storage.write(fixture.infoKey(fixture.messages[0].info), fixture.messages[0].info)
        })
        const entered = Promise.withResolvers<void>()
        const queued = Promise.withResolvers<void>()
        const release = Promise.withResolvers<void>()
        const writer = first.run(() =>
          Storage.transaction(async () => {
            entered.resolve()
            await release.promise
          }),
        )
        void writer.catch(entered.reject)
        let pending: Promise<void> | undefined
        try {
          await guarded(entered.promise)
          pending = first.run(() =>
            withStorageQueueOptions({ onWait: (waiting) => waiting && queued.resolve() }, () =>
              Display.prepareWindow(fixture.scopeID, fixture.sessionID, [fixture.messages[0].info]),
            ),
          )
          void pending.catch(queued.reject)
          await guarded(queued.promise)
          await guarded(
            second.run(() => Display.prepareWindow(fixture.scopeID, fixture.sessionID, [fixture.messages[0].info])),
          )
          expect(
            await second.run(() => Display.header(fixture.scopeID, fixture.sessionID, fixture.messages[0].info.id)),
          ).toBeDefined()
        } finally {
          release.resolve()
          await Promise.allSettled([writer, pending])
        }
      }))
  })
}
