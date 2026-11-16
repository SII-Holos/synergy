import type { Info } from "../types"
import type { RolloutSchema } from "./schema"

export namespace RolloutOwner {
  export function session(session: Pick<Info, "scope" | "id">): RolloutSchema.Owner {
    return { kind: "session", scopeID: session.scope.id, sessionID: session.id }
  }
}
