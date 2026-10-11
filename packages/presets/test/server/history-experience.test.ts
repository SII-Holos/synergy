import { expect, spyOn, test } from "bun:test"
import path from "node:path"
import { createSynergyClient } from "@ericsanchezok/synergy-sdk/client"
import { PresetRuntimeHandle } from "../../src/server/runtime-handle"
import { runtimeHome } from "@ericsanchezok/synergy-harness/test/support/runtime-home"
import { TransactionalStore } from "@ericsanchezok/synergy-harness/storage/transactional-store"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { StoragePath } from "@ericsanchezok/synergy-harness/storage/path"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import type { ScopeNavIndex } from "@ericsanchezok/synergy-harness/session/nav"
import { Identifier } from "@ericsanchezok/synergy-harness/id/id"

test("full resident startup, old message pages and new sessions avoid unrelated cold owners", async () => {
  await using fixture = await runtimeHome()
  const store = await TransactionalStore.open({
    backend: "sqlite",
    filename: path.join(fixture.host.root, "history.sqlite"),
    namespace: "history",
  })
  try {
    const storage = {
      kind: "borrowed" as const,
      handle: { store, artifactDirectory: path.join(fixture.host.root, "data") },
    }
    const ids: string[] = []
    const prepared = await PresetRuntimeHandle.openTask({ host: fixture.host, storage, mode: "oneshot" })
    let session: Session.Info
    try {
      session = await prepared.run(() =>
        ScopeContext.provide({
          scope: Scope.home(),
          fn: async () => {
            const session = await Session.create({ title: "Historical conversation", workspace: null })
            for (let index = 0; index < 300; index++) {
              const id = Identifier.ascending("message")
              ids.push(id)
              await Session.updateMessage({
                id,
                sessionID: session.id,
                role: "user",
                agent: "general",
                model: { providerID: "fixture", modelID: "fixture" },
                time: { created: index + 1 },
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
                text: "Readable historical message",
              })
            }
            const replyID = Identifier.ascending("message")
            await Session.updateMessage({
              id: replyID,
              sessionID: session.id,
              role: "assistant",
              parentID: ids.at(-1)!,
              rootID: ids.at(-1)!,
              time: { created: 301, completed: 302 },
              finish: "stop",
              modelID: "fixture",
              providerID: "fixture",
              path: { cwd: fixture.host.root, root: fixture.host.root },
              mode: "general",
              agent: "general",
              cost: 0,
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            })
            ids.push(replyID)
            await Storage.removeTree(["sessions", "home", session.id, "display_message"])
            await Storage.removeTree(["sessions", "home", session.id, "display_timeline"])
            await Storage.remove(StoragePath.sessionDisplayState("home", session.id))
            return session
          },
        }),
      )
    } finally {
      await prepared.close()
    }
    const coldIDs: string[] = Array.from({ length: 5000 }, () => Identifier.ascending("session"))
    for (let first = 0; first < 5000; first += 100) {
      await store.transaction(async (tx) => {
        const rows = []
        for (let index = first; index < first + 100; index++) {
          const id = coldIDs[index]!
          rows.push({ key: ["sessions", "home", id, "info"], value: { ...session, id } })
          rows.push({
            key: ["operations", "home", id, "rollout", "journal", "events", "000000000001"],
            value: { historical: "evidence".repeat(128) },
          })
        }
        await tx.writeMany(rows)
      })
    }
    await store.transaction(async (tx) => {
      const key = StoragePath.sessionNavIndex(Identifier.asScopeID("home"))
      const nav = await tx.read<ScopeNavIndex>(key)
      const original = nav.entries[0]!
      nav.entries.push(...coldIDs.map((id) => ({ ...original, id })))
      await tx.write(key, nav)
    })
    using reads = spyOn(Storage, "read")
    using batches = spyOn(Storage, "readMany")
    using markerInventories = spyOn(Storage, "scan")
    const start = performance.now()
    await using runtime = await PresetRuntimeHandle.open({
      host: fixture.host,
      storage,
      mode: "server",
      network: { hostname: "127.0.0.1", port: 0 },
    })
    const startupMs = performance.now() - start
    const client = createSynergyClient({ baseUrl: `http://127.0.0.1:${runtime.server.port}` })
    const options = () => ({ throwOnError: true as const, signal: AbortSignal.timeout(30_000) })
    const opening = performance.now()
    const page = await client.session.timelinePage({ sessionID: session.id, scopeID: "home", limit: 10 }, options())
    expect(page.data.items.map((item) => item.info.id)).toEqual(ids.slice(-10))
    const [parts, created] = await Promise.all([
      client.session.partPages(
        { sessionID: session.id, scopeID: "home", messageIDs: ids.slice(-10), limit: 10 },
        options(),
      ),
      client.session.create({ scopeID: "home", title: "New work", workspace: { mode: "none" } }, options()),
    ])
    expect(parts.response.ok).toBe(true)
    expect(created.data.id).not.toBe(session.id)
    const interactionMs = performance.now() - opening
    const historical = (key: string[]) => key[0] === "operations" || coldIDs.includes(key[2]!)
    expect(reads.mock.calls.filter(([key]) => historical(key)).length).toBe(0)
    expect(batches.mock.calls.flatMap(([keys]) => keys.filter(historical))).toEqual([])
    expect(
      markerInventories.mock.calls.filter(([key]) => key[0] === "session_message_order_v1" && key[2] === session.id),
    ).toEqual([])
    // These are hang guards for shared CI runners, not workstation experience targets.
    expect(startupMs).toBeLessThan(30_000)
    expect(interactionMs).toBeLessThan(30_000)
    console.info(JSON.stringify({ fixture: "resident-history-experience", coldOwners: 5000, startupMs, interactionMs }))
  } finally {
    await store.close()
  }
}, 120_000)
