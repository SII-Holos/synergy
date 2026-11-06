import { z } from "zod"
import { SessionSchemaRegistry } from "@ericsanchezok/synergy-harness/session/schema-registry"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { StoragePath } from "@ericsanchezok/synergy-harness/storage/path"
export const SessionFields = { agenda: z.object({ itemID: z.string() }).optional() }
type SessionShape = typeof SessionFields
declare module "@ericsanchezok/synergy-harness/session/types" {
  interface SessionExtensionShape extends SessionShape {}
  interface SessionCreationExtensions {
    agenda?: z.infer<typeof SessionFields.agenda>
  }
}
export function registerSessionSchema() {
  SessionSchemaRegistry.register("agenda", {
    shape: SessionFields,
    isBackground: (input) => Boolean(input.agenda),
    async created(input) {
      const agenda = SessionFields.agenda.parse(input.agenda)
      if (!agenda) return
      const sessionID = z.string().parse(input.id)
      const scope = z.object({ id: z.string() }).parse(input.scope)
      await Storage.write(StoragePath.agendaSession(agenda.itemID, sessionID), { sessionID, scopeID: scope.id })
    },
    normalizeImport(input, mode) {
      if (mode === "transcript") input.agenda = undefined
    },
  })
}
