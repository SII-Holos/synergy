import { expect, test } from "bun:test"
import z from "zod"
import { tmpdir } from "../support/fixture"
import { Identifier } from "../../src/id/id"
import { ScopeContext } from "../../src/scope/context"
import { Storage } from "../../src/storage/storage"
import { StoragePath } from "../../src/storage/path"
import { Session } from "../../src/session"
import { SessionExport } from "../../src/session/session-export"
import { SessionImport } from "../../src/session/session-import"

test("core session edits and transcript round trips preserve unregistered domain state", async () => {
  await using tmp = await tmpdir({ git: true })
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const session = await Session.create({ title: "Stored experiment" })
      const research = {
        version: 3 as const,
        trialIDs: ["trial-a", "trial-b"],
        checkpoint: { cursor: 17, flags: [false, true] },
      }
      const key = StoragePath.sessionInfo(Identifier.asScopeID(session.scope.id), Identifier.asSessionID(session.id))
      const original = await Storage.read<Record<string, unknown>>(key)
      await Storage.write(key, { ...original, research })
      expect(((await Session.get(session.id)) as unknown as Record<string, unknown>).research).toEqual(research)
      await Session.update(session.id, (draft) => {
        draft.title = "Edited by the core"
      })
      expect((await Storage.read<Record<string, unknown>>(key)).research).toEqual(research)

      const exported = await SessionExport.generate({ sessionID: session.id, mode: "full" })
      expect((exported.sessions[0].info as unknown as Record<string, unknown>).research).toEqual(research)
      const parsed = SessionImport.parse(new TextEncoder().encode(JSON.stringify(exported)))
      expect((parsed.sessions[0].info as unknown as Record<string, unknown>).research).toEqual(research)
      const imported = await SessionImport.fromReport(parsed)
      const ownerSchema = z
        .object({
          research: z.object({
            version: z.literal(3),
            trialIDs: z.array(z.string()),
            checkpoint: z.object({ cursor: z.number(), flags: z.array(z.boolean()) }),
          }),
        })
        .passthrough()
      const restored = ownerSchema.parse(await Session.get(imported.rootSessionID))
      expect(restored.research).toEqual(research)
      expect(restored.title).toBe("Edited by the core")

      const api = z.toJSONSchema(Session.Info, { unrepresentable: "any" })
      expect(api.properties).not.toHaveProperty("blueprint")
      expect(api.additionalProperties).toBe(false)
    },
  })
})
