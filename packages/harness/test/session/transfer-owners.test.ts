import { expect, test } from "bun:test"
import { testRuntime } from "../support/runtime"
import { SessionTransferOwners as Owners } from "../../src/session/transfer-owners"
import { SessionTransferEpochs as Epochs } from "../../src/session/transfer-epochs"
import { Session } from "../../src/session"
import { SessionLifecycle } from "../../src/session/lifecycle"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { Storage } from "../../src/storage/storage"

test("portable owner compatibility is directional and unknown required owners stay blocked", async () => {
  await using runtime = await testRuntime({
    register() {
      Owners.register("fixture", {
        version: 2,
        reads: [1, 2],
        applies: () => true,
        async inspect() {
          return { requirements: [], children: (async function* () {})() }
        },
        async freeze() {},
        async *export(context) {
          yield {
            id: "retained",
            kind: "record",
            metadata: { key: ["fixture", context.session.id] },
            content: (async function* () {
              yield new TextEncoder().encode(JSON.stringify(await Storage.read(["fixture", context.session.id])))
            })(),
          }
        },
        async validate() {},
        async publish() {},
      })
    },
  })
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const session = await Session.create({ workspace: null })
        await Storage.write(["fixture", session.id], { retained: "completed result" })
        expect(Owners.compatibility({ fixture: 1 })).toEqual([])
        expect(Owners.compatibility({ fixture: 3 })).toMatchObject([{ code: "owner_schema", owner: "fixture" }])
        expect(Owners.compatibility({ unavailable: 1 })).toMatchObject([
          { code: "owner_missing", owner: "unavailable" },
        ])
        const context = {
          session,
          rootSessionID: session.id,
          handoffID: "owner-transfer",
          signal: new AbortController().signal,
        }
        const key = ["sessions", "home", session.id, "info"]
        const original = await Storage.read<Record<string, unknown>>(key)
        await Storage.write(key, { ...original, workflow: { kind: "unselected-workflow" } })
        expect(context.session.workflow).toBeUndefined()
        await expect(Owners.selected(context)).rejects.toMatchObject({
          data: { requirements: [{ code: "owner_missing", owner: "unselected-workflow" }] },
        })
        await Storage.write(key, original)
        await expect(
          (async () => {
            for await (const _entry of Owners.entries(context, ["fixture"])) {
            }
          })(),
        ).rejects.toThrow("frozen")
        await SessionLifecycle.pause({ sessionID: session.id, reason: "interrupted" })
        await Epochs.freeze({
          sessionID: session.id,
          scopeID: "home",
          handoffID: context.handoffID,
          sourceID: "A",
          targetID: "B",
          fromEpoch: 1,
          toEpoch: 2,
        })
        let retained = ""
        for await (const entry of Owners.entries(context, ["fixture"])) {
          expect(entry.metadata.transferOwner).toBe("fixture")
          for await (const chunk of entry.content) retained += new TextDecoder().decode(chunk)
        }
        expect(JSON.parse(retained)).toEqual({ retained: "completed result" })
      },
    }),
  )
})
