import { describe, expect, test } from "bun:test"
import { NoteStore } from "../../src/note"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import {
  BlueprintPluginErrorCode,
  cancelBlueprintLoop,
  createBlueprintLoop,
  getBlueprintLoop,
  listBlueprintLoops,
} from "../../src/blueprint/plugin-adapter"
import { tmpdir } from "../fixture/fixture"

describe("Blueprint plugin adapter", () => {
  test("creates a plugin-owned loop from a Blueprint Note in the active Scope", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const note = await NoteStore.create({
          title: "Plugin Blueprint",
          kind: "blueprint",
          blueprint: {
            description: "Delegated through the existing loop service",
            defaultAgent: "synergy-max",
            auditAgent: "supervisor",
          },
        })
        const session = await Session.create({})
        const loop = await createBlueprintLoop({
          pluginId: "research-plugin",
          pluginGeneration: "generation-one",
          scopeId: ScopeContext.current.scope.id,
          sessionId: session.id,
          request: { noteID: note.id },
        })

        expect(loop).toMatchObject({
          noteID: note.id,
          noteVersion: note.version,
          title: note.title,
          description: note.blueprint?.description,
          sessionID: session.id,
          status: "armed",
          source: "plugin",
          pluginOwner: {
            pluginId: "research-plugin",
            pluginGeneration: "generation-one",
            scopeId: ScopeContext.current.scope.id,
          },
        })
        expect(await getBlueprintLoop({ scopeId: ScopeContext.current.scope.id, loopID: loop.id })).toEqual(loop)
        expect((await listBlueprintLoops(ScopeContext.current.scope.id)).map((item) => item.id)).toContain(loop.id)
      },
    })
  })

  test("rejects ordinary Notes and ownership mismatches", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const note = await NoteStore.create({ title: "Ordinary note" })
        const session = await Session.create({})
        await expect(
          createBlueprintLoop({
            pluginId: "research-plugin",
            pluginGeneration: "generation-one",
            scopeId: ScopeContext.current.scope.id,
            sessionId: session.id,
            request: { noteID: note.id },
          }),
        ).rejects.toMatchObject({ code: BlueprintPluginErrorCode.NOTE_INVALID })

        const blueprint = await NoteStore.create({ title: "Blueprint", kind: "blueprint", blueprint: {} })
        const loop = await createBlueprintLoop({
          pluginId: "research-plugin",
          pluginGeneration: "generation-one",
          scopeId: ScopeContext.current.scope.id,
          sessionId: session.id,
          request: { noteID: blueprint.id },
        })
        await expect(
          cancelBlueprintLoop({
            pluginId: "other-plugin",
            pluginGeneration: "generation-one",
            scopeId: ScopeContext.current.scope.id,
            loopID: loop.id,
          }),
        ).rejects.toMatchObject({ code: BlueprintPluginErrorCode.OWNER_MISMATCH })
      },
    })
  })
})
