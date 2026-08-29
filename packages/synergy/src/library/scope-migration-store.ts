import { ScopeLibraryStore } from "../scope/library-store"
import { LibraryDB } from "./database"

/**
 * S9d source inversion: scope migrations touch library experience data
 * through this registered store instead of importing the library product
 * domain. Loaded through src/product-registration.ts.
 */
export function registerScopeLibraryStore() {
  ScopeLibraryStore.register({
    experienceScopeIDs() {
      const rows = LibraryDB.connection().prepare("SELECT DISTINCT scope_id FROM experience").all() as {
        scope_id: string
      }[]
      return rows.map((row) => row.scope_id)
    },
    removeExperiencesByScope: (scopeID) => LibraryDB.Experience.removeByScope(scopeID),
    renameExperienceScope: (fromScopeID, toScopeID) => LibraryDB.Experience.renameScope(fromScopeID, toScopeID),
  })
}
