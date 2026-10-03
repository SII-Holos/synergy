import { describe, expect, spyOn, test } from "bun:test"
import { Identifier } from "../../src/id/id"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { StorageIntegrityError, StorageUnavailableError } from "../../src/storage/errors"
import { StoragePath } from "../../src/storage/path"
import { Storage } from "../../src/storage/storage"
import { testRuntime } from "../support/runtime"
import { storageTestBackends } from "../support/storage-backends"

type Fixture = {
  scopeID: Identifier.ScopeID
  sessionID: Identifier.SessionID
  newestIDs: Identifier.MessageID[]
}

async function withMessages(backend: "sqlite" | "postgres", fn: (fixture: Fixture) => Promise<void>, count = 8) {
  await using runtime = await testRuntime({
    postgres: backend === "postgres" ? process.env.SYNERGY_TEST_POSTGRES_URL! : undefined,
  })
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      fn: async () => {
        const session = await Session.create({ workspace: null })
        const ids = Array.from({ length: count }, () => Identifier.ascending("message")).toReversed()
        await Storage.transaction(async () => {
          for (const [index, id] of ids.entries()) {
            await Session.updateMessage({
              id,
              sessionID: session.id,
              role: "user",
              agent: "history-fixture",
              model: { providerID: "fixture", modelID: "fixture" },
              time: { created: 1000 + index },
              isRoot: true,
              rootID: id,
              visible: true,
              origin: { type: "user" },
            })
            await Session.updatePart({
              id: Identifier.ascending("part"),
              sessionID: session.id,
              messageID: id,
              type: "text",
              text: `Message ${index}`,
              origin: "user",
            })
          }
        })
        await fn({
          scopeID: Identifier.asScopeID(ScopeContext.current.scope.id),
          sessionID: Identifier.asSessionID(session.id),
          newestIDs: ids.toReversed(),
        })
      },
    }),
  )
}

for (const backend of storageTestBackends()) {
  describe(`newest message reads (${backend})`, () => {
    for (const { label, offset } of [
      { label: "first message", offset: 0 },
      { label: "later individual message", offset: 2 },
      { label: "batched messages", offset: 4 },
    ]) {
      test(
        `preserves the storage error for ${label}`,
        () =>
          withMessages(backend, async ({ scopeID, sessionID, newestIDs }) => {
            const target = StoragePath.messageInfo(scopeID, sessionID, newestIDs[offset])
            const fault =
              offset === 0
                ? new StorageUnavailableError("Synthetic message read failure")
                : new StorageIntegrityError("Synthetic message integrity failure")
            const read = Storage.read
            const readMany = Storage.readMany
            let hits = 0
            using singleRead = spyOn(Storage, "read").mockImplementation(
              async <T>(key: string[], options?: { silentNotFound?: boolean }) => {
                const value = await read<T>(key, options)
                if (offset < 4 && JSON.stringify(key) === JSON.stringify(target)) {
                  hits++
                  throw fault
                }
                return value
              },
            )
            using batchRead = spyOn(Storage, "readMany").mockImplementation(async <T>(keys: string[][]) => {
              const values = await readMany<T>(keys)
              if (offset >= 4 && keys.some((key) => JSON.stringify(key) === JSON.stringify(target))) {
                hits++
                throw fault
              }
              return values
            })
            const stream = MessageV2.stream({ scopeID, sessionID })
            try {
              for (let index = 0; index < offset; index++) {
                expect((await stream.next()).value?.info.id).toBe(newestIDs[index])
              }
              const result = await stream.next().then(
                (value) => ({ value, error: undefined }),
                (error: unknown) => ({ value: undefined, error }),
              )
              expect(hits).toBe(1)
              expect(result.error).toBe(fault)
              expect(result.value).toBeUndefined()
              expect((await stream.next()).done).toBe(true)
            } finally {
              await stream.return()
            }
          }),
        30_000,
      )
    }

    for (const offset of [0, 4]) {
      test(
        `preserves part hydration failures at message ${offset + 1}`,
        () =>
          withMessages(backend, async ({ scopeID, sessionID, newestIDs }) => {
            const fault =
              offset === 0
                ? new StorageUnavailableError("Synthetic part read failure")
                : new StorageIntegrityError("Synthetic part integrity failure")
            const records = Storage.records
            let hits = 0
            using partRead = spyOn(Storage, "records").mockImplementation(async function* <T>(input) {
              for await (const record of records<T>(input)) {
                if (input?.kind === "part" && input.messageID === newestIDs[offset]) {
                  hits++
                  throw fault
                }
                yield record
              }
            })
            const stream = MessageV2.stream({ scopeID, sessionID })
            try {
              for (let index = 0; index < offset; index++) {
                expect((await stream.next()).value?.info.id).toBe(newestIDs[index])
              }
              const result = await stream.next().then(
                (value) => ({ value, error: undefined }),
                (error: unknown) => ({ value: undefined, error }),
              )
              expect(hits).toBe(1)
              expect(result.error).toBe(fault)
              expect(result.value).toBeUndefined()
              expect((await stream.next()).done).toBe(true)
            } finally {
              await stream.return()
            }
          }),
        30_000,
      )
    }

    test(
      "skips messages deleted after the order snapshot in single and batch reads",
      () =>
        withMessages(backend, async ({ scopeID, sessionID, newestIDs }) => {
          const stream = MessageV2.stream({ scopeID, sessionID })
          try {
            expect((await stream.next()).value?.info.id).toBe(newestIDs[0])
            const removed = [newestIDs[1], newestIDs[6]]
            for (const messageID of removed) {
              await Session.removeMessage({ sessionID, messageID })
              await expect(Storage.read(StoragePath.messageInfo(scopeID, sessionID, messageID))).rejects.toBeInstanceOf(
                Storage.NotFoundError,
              )
            }
            const remaining: string[] = []
            for await (const message of stream) remaining.push(message.info.id)
            expect(remaining).toEqual(newestIDs.slice(1).filter((id) => !removed.includes(id)))
          } finally {
            await stream.return()
          }
        }),
      30_000,
    )

    test(
      "preserves complete chronological history across read batches and cursor pages",
      () =>
        withMessages(
          backend,
          async ({ scopeID, sessionID, newestIDs }) => {
            const streamed: MessageV2.WithParts[] = []
            for await (const message of MessageV2.stream({ scopeID, sessionID })) streamed.push(message)
            expect(streamed.map((message) => message.info.id)).toEqual(newestIDs)
            expect(streamed.map((message) => message.parts[0])).toEqual(
              newestIDs.map((_, index) => expect.objectContaining({ type: "text", text: `Message ${39 - index}` })),
            )
            const pages: string[] = []
            let cursor: string | undefined
            do {
              const page = await Session.messagePage({ sessionID, limit: 13, cursor })
              expect(page.total).toBe(newestIDs.length)
              pages.push(...page.items.map((message) => message.info.id).toReversed())
              cursor = page.nextCursor ?? undefined
            } while (cursor)
            expect(pages).toEqual(newestIDs)
          },
          40,
        ),
      30_000,
    )
  })
}
