import { expect, test } from "bun:test"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionLifecycle } from "@ericsanchezok/synergy-harness/session/lifecycle"
import { SessionTransferEpochs as Epochs } from "@ericsanchezok/synergy-harness/session/transfer"
import { NoteStore, NoteMarkdown, NoteTransferSnapshots } from "../src"
import { testRuntime } from "./support/runtime"

test("handoff Note snapshots seal exact versions across edits and retain bytes until its outcome is known", async () => {
  await using runtime = await testRuntime()
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const session = await Session.create({ workspace: null })
        const note = await NoteStore.create({
          title: "Selected current document",
          content: NoteMarkdown.fromMarkdown("![Original](asset://0123456789abcdef.png)"),
        })
        await SessionLifecycle.pause({ sessionID: session.id, reason: "interrupted" })
        const binding = {
          sessionID: session.id,
          scopeID: "home",
          handoffID: "note-snapshot",
          sourceID: "A",
          targetID: "B",
          fromEpoch: 1,
          toEpoch: 2,
        }
        const context = {
          session: await Session.get(session.id),
          rootSessionID: session.id,
          handoffID: binding.handoffID,
          signal: new AbortController().signal,
        }
        await Epochs.beginSource(binding)
        const selections = () =>
          (async function* () {
            yield { noteID: note.id }
          })()
        const sealed = await NoteTransferSnapshots.seal(context, selections())
        await NoteStore.update("home", note.id, {
          title: "Later authoring content",
          content: NoteMarkdown.fromMarkdown("![Later](asset://fedcba9876543210.png)"),
        })
        expect(await NoteTransferSnapshots.seal(context, selections())).toEqual(sealed)
        const selected = []
        for await (const item of NoteTransferSnapshots.read(context)) selected.push(item)
        expect(selected).toHaveLength(1)
        expect(selected[0].note.title).toBe(note.title)
        expect(selected[0].note.version).toBe(note.version)
        const dependencies = []
        for await (const dependency of NoteTransferSnapshots.dependencies(context)) dependencies.push(dependency)
        expect(dependencies).toEqual([{ kind: "asset", reference: "asset://0123456789abcdef.png" }])
        await NoteStore.archive("home", [note.id])
        await expect(NoteStore.remove("home", note.id)).rejects.toThrow("transfer")
        await Epochs.freeze(binding)
        await expect(NoteStore.remove("home", note.id)).rejects.toThrow("transfer")
        await expect(NoteTransferSnapshots.seal({ ...context, handoffID: "forged" }, selections())).rejects.toThrow()
        await Epochs.cancel(binding)
        await NoteStore.remove("home", note.id)
        await expect(NoteStore.getVersion("home", note.id, note.version)).rejects.toThrow()
      },
    }),
  )
}, 20000)
