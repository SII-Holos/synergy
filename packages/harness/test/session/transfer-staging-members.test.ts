import { expect, test } from "bun:test"
import { testRuntime } from "../support/runtime"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { SessionTransferCore as Core } from "../../src/session/transfer-core"
import { SessionTransferSource as Source } from "../../src/session/transfer-source"
import { SessionTransferStaging as Staging } from "../../src/session/transfer-staging"
import { Storage } from "../../src/storage/storage"
import { TransactionalStore } from "../../src/storage/transactional-store"
import { tmpdir } from "../support/fixture"
import path from "node:path"

test("verified staging enumerates only its complete native cohort in parent-first order without publishing Sessions", async () => {
  await using source = await testRuntime({ register: Core.register })
  await using target = await testRuntime({ register: Core.register })
  const values = new Map<string, Uint8Array>()
  const store = {
    async put(hash: string, bytes: Uint8Array) {
      values.set(hash, bytes.slice())
    },
    async get(hash: string) {
      const bytes = values.get(hash)
      if (!bytes) throw new Error("Captured object is unavailable")
      return bytes.slice()
    },
  }
  const signal = new AbortController().signal
  const captured = await source.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const root = await Session.create({ id: "ses_z_parent", workspaceID: null, environmentID: null })
        const child = await Session.create({
          id: "ses_a_child",
          parentID: root.id,
          workspaceID: null,
          environmentID: null,
        })
        const descendant = await Session.create({
          id: "ses_m_descendant",
          parentID: child.id,
          workspaceID: null,
          environmentID: null,
        })
        const binding = {
          sessionID: root.id,
          scopeID: root.scope.id,
          handoffID: "staged-native-members",
          sourceID: "source",
          targetID: "target",
          fromEpoch: 1,
          toEpoch: 2,
        }
        const prepared = await Source.prepare({ binding, store, signal, async verify() {} })
        return { binding, prepared, ids: [root.id, child.id, descendant.id] }
      },
    }),
  )
  await source.run(() =>
    Staging.receive({ handoffID: captured.binding.handoffID, root: captured.prepared.root, store, signal }),
  )
  await target.run(async () => {
    await Staging.receive({ handoffID: captured.binding.handoffID, root: captured.prepared.root, store, signal })
    const input = {
      handoffID: captured.binding.handoffID,
      rootSessionID: captured.binding.sessionID,
      scopeID: captured.binding.scopeID,
      signal,
    }
    const ids: string[] = []
    for await (const member of Staging.members(input)) {
      ids.push(member.session.id)
      expect(member.owners).toEqual({ "session-core": 2 })
      expect(member.session.scope.id).toBe(captured.binding.scopeID)
      expect(member.session.paused).toBeDefined()
      await expect(Session.get(member.session.id)).rejects.toThrow()
    }
    expect(ids).toEqual(captured.ids)
    const initiallyEscaped = Staging.members(input)
    try {
      await source.run(async () => {
        await expect(initiallyEscaped.next()).rejects.toThrow("another Runtime or Store")
      })
    } finally {
      await initiallyEscaped.return(undefined)
    }
    const changedInput = { ...input }
    const fixed = Staging.members(changedInput)
    changedInput.handoffID = "different-handoff"
    changedInput.rootSessionID = captured.ids[1]!
    changedInput.scopeID = "different-scope"
    changedInput.signal = AbortSignal.abort(new Error("A replacement signal cannot retarget this iterator"))
    try {
      expect((await fixed.next()).value?.session.id).toBe(captured.ids[0])
    } finally {
      await fixed.return(undefined)
    }
    const wrong = Staging.members({ ...input, rootSessionID: captured.ids[1] })
    await expect(wrong.next()).rejects.toThrow()
    const cancelled = new AbortController()
    const iterator = Staging.members({ ...input, signal: cancelled.signal })
    expect((await iterator.next()).value?.session.id).toBe(captured.ids[0])
    const reason = new Error("Stop staged member discovery")
    cancelled.abort(reason)
    await expect(iterator.next()).rejects.toBe(reason)
    const escaped = Staging.members(input)
    await escaped.next()
    await source.run(async () => {
      await expect(escaped.next()).rejects.toThrow("another Runtime or Store")
    })
    await using foreignDirectory = await tmpdir()
    const foreign = await TransactionalStore.open({
      backend: "sqlite",
      filename: path.join(foreignDirectory.path, "foreign.sqlite"),
      namespace: "foreign",
    })
    try {
      const current = Storage.current()
      for (const storage of [
        { store: foreign, artifactDirectory: path.join(foreignDirectory.path, "artifacts") },
        { store: current.store, artifactDirectory: path.join(foreignDirectory.path, "redirected") },
      ]) {
        const initiallyEscaped = Staging.members(input)
        try {
          await Storage.provide(storage, async () => {
            await expect(initiallyEscaped.next()).rejects.toThrow("another Runtime or Store")
          })
        } finally {
          await initiallyEscaped.return(undefined)
        }
        const iterator = Staging.members(input)
        await iterator.next()
        await Storage.provide(storage, async () => {
          await expect(iterator.next()).rejects.toThrow("another Runtime or Store")
          if (storage.store === foreign) expect(await Storage.query({ prefix: ["sessions"], limit: 1 })).toEqual([])
        })
      }
    } finally {
      await foreign.close()
    }
  })
}, 15000)
