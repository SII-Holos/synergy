import { expect, test } from "bun:test"
import z from "zod"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionSchemaRegistry } from "@ericsanchezok/synergy-harness/session/schema-registry"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { StoragePath } from "@ericsanchezok/synergy-harness/storage/path"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { WorkflowInfo, registerSessionSchema } from "../src/session-schema"

test("owner schema preserves the full API union while persistence retains future workflow state", async () => {
  registerSessionSchema()
  const schema = z.toJSONSchema(WorkflowInfo, { unrepresentable: "any" })
  expect(schema).toMatchObject({ anyOf: expect.any(Array) })
  expect(WorkflowInfo.parse({ kind: "plan" })).toEqual({ kind: "plan" })
  expect(WorkflowInfo.parse({ kind: "lattice", runID: "run-1", mode: "auto" })).toEqual({
    kind: "lattice",
    runID: "run-1",
    mode: "auto",
  })
  expect(WorkflowInfo.safeParse({ kind: "future-research" }).success).toBe(false)
  await using tmp = await tmpdir()
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const created = await Session.create({ title: "future owner" })
      const raw = {
        ...created,
        workflow: { kind: "future-research", state: { checkpoints: [1, { value: false }] } },
        blueprint: { loopID: "old-loop", nested: { future: true } },
      }
      const parsed = Session.PersistedInfo.parse(raw)
      expect(parsed.workflow).toEqual(raw.workflow)
      expect(parsed.blueprint).toEqual(raw.blueprint)
      const older = {
        ...raw,
        workflow: { kind: "lightloop", instructions: "continue", stopRequest: { unknown: { nested: [1, 2] } } },
      }
      expect(Session.PersistedInfo.parse(older).workflow).toEqual(older.workflow)
      await Session.remove(created.id)
    },
  })
})

test("registered Agenda creation preserves scheduling index and default control policy", async () => {
  await using tmp = await tmpdir()
  const scope = await tmp.scope()
  await ScopeContext.provide({
    scope,
    fn: async () => {
      const scheduled = await Session.create({ agenda: { itemID: "agenda-owner" } })
      expect(scheduled.category).toBe("background")
      expect(Session.defaultControlProfileForSessionSource(scheduled)).toBe("autonomous")
      expect(
        await Storage.read<{ sessionID: string; scopeID: string }>(
          StoragePath.agendaSession("agenda-owner", scheduled.id),
        ),
      ).toEqual({
        sessionID: scheduled.id,
        scopeID: scope.id,
      })
      const transcript = { agenda: scheduled.agenda, workflow: { kind: "plan" }, blueprint: { loopID: "loop" } }
      SessionSchemaRegistry.normalizeImport(transcript, "transcript")
      expect(transcript.agenda).toBeUndefined()
      expect(transcript.workflow).toEqual({ kind: "plan" })
      SessionSchemaRegistry.normalizeImport(transcript, "archive")
      expect(transcript.workflow).toBeUndefined()
      expect(transcript.blueprint).toBeUndefined()
      await Session.remove(scheduled.id)
    },
  })
})
