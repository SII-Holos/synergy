import { z } from "zod"

export namespace SessionPartCommit {
  export const RecordCommitted = {
    type: "message.part.committed" as const,
    properties: z.strictObject({
      scopeID: z.string(),
      sessionID: z.string(),
      messageID: z.string(),
      partID: z.string(),
      revision: z.string().regex(/^\d+$/),
      removed: z.boolean(),
    }),
  }
}
