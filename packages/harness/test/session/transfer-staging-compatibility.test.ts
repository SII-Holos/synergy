import { expect, spyOn, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "../support/fixture"
import { testRuntime } from "../support/runtime"
import { Session } from "../../src/session"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { Storage } from "../../src/storage/storage"
import { SessionTransferCore as Core } from "../../src/session/transfer-core"
import { SessionTransferOwners as Owners } from "../../src/session/transfer-owners"
import { SessionTransferStaging as Staging } from "../../src/session/transfer-staging"
import { SessionTransferStream as Stream } from "../../src/session/transfer-stream"

const owner: Owners.Contribution = {
  version: 1,
  reads: [1],
  applies: () => false,
  async inspect() {
    return {
      requirements: [],
      children: (async function* () {
        yield* []
      })(),
    }
  },
  async freeze() {},
  async *export() {
    yield* []
  },
  async validate() {},
  async publish() {},
}

test("a cold Runtime cannot reuse or interpret verified staging through an incompatible owner reader", async () => {
  await using home = await tmpdir()
  await using objects = await tmpdir()
  const store = {
    async put(hash: string, bytes: Uint8Array) {
      await Bun.write(path.join(objects.path, hash), bytes)
    },
    async get(hash: string, maximumBytes: number) {
      const file = Bun.file(path.join(objects.path, hash))
      if (file.size > maximumBytes) throw new Error("Oversized object")
      return new Uint8Array(await file.arrayBuffer())
    },
  }
  const source = await testRuntime({
    home: home.path,
    register() {
      Owners.register("session-core", { ...owner, version: 3, reads: [3] })
      Owners.register("snapshot-reader", { ...owner, stagedDependencies: ["session-core"] })
    },
  })
  const previous = await source.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const session = await Session.create({ workspace: null, environmentID: null })
        const root = await Stream.write({
          store,
          owners: { "session-core": 3, "snapshot-reader": 1 },
          entries: (async function* () {
            yield {
              id: "future-core",
              kind: "record" as const,
              metadata: {
                transferOwner: "session-core",
                transferSessionID: session.id,
                key: ["future-core", session.id],
              },
              content: (async function* () {
                yield Buffer.from(JSON.stringify({ futureLayout: true }))
              })(),
            }
          })(),
        })
        await Staging.receive({ handoffID: "cold-incompatible", root, store })
        return { session, root }
      },
    }),
  )
  await source.close()
  await using downgraded = await testRuntime({
    home: home.path,
    register() {
      Core.register()
      Owners.register("snapshot-reader", { ...owner, stagedDependencies: ["session-core"] })
    },
  })
  await downgraded.run(async () => {
    expect((await Staging.inspect("cold-incompatible")).phase).toBe("verified")
    using bytes = spyOn(Storage, "readBinary")
    await expect(Staging.receive({ handoffID: "cold-incompatible", root: previous.root, store })).rejects.toThrow(
      "incompatible",
    )
    await expect(
      Staging.context({
        ownerID: "session-core",
        handoffID: "cold-incompatible",
        session: previous.session,
        rootSessionID: previous.session.id,
        mapping: {},
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("incompatible")
    const context = await Staging.context({
      ownerID: "snapshot-reader",
      handoffID: "cold-incompatible",
      session: previous.session,
      rootSessionID: previous.session.id,
      mapping: {},
      signal: new AbortController().signal,
    })
    await expect(context.staged.relatedRecords!("session-core")[Symbol.asyncIterator]().next()).rejects.toThrow(
      "incompatible",
    )
    await expect(context.staged.relatedRecord!("session-core", ["future-core", previous.session.id])).rejects.toThrow(
      "incompatible",
    )
    expect(bytes).not.toHaveBeenCalled()
  })
}, 15000)
