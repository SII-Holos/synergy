import { z } from "zod"
import { StorageIntegrityError } from "./errors"

const legacySessionInfo = z.object({
  scope: z.object({ id: z.string() }),
  title: z.string(),
  time: z.object({ created: z.number(), updated: z.number() }),
})

export function validateLegacyRecord(key: string[], value: unknown) {
  if (
    key[0] === "projects" &&
    (!value || typeof value !== "object" || Array.isArray(value) || !("id" in value) || value.id !== key[1])
  )
    throw new StorageIntegrityError("Legacy Scope identity does not match its key")
  if (
    key[0] === "meta" &&
    key[1] === "migration" &&
    (!value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.values(value).some((timestamp) => typeof timestamp !== "number" || !Number.isFinite(timestamp)))
  )
    throw new StorageIntegrityError("Legacy migration ledger is malformed")
  if (key[0] === "sessions" && (key[3] === "info" || key[3] === "messages")) {
    const expectedID = key.at(-1) === "info" ? key.at(-2) : key.at(-1)
    if (!value || typeof value !== "object" || Array.isArray(value) || !("id" in value) || value.id !== expectedID)
      throw new StorageIntegrityError("Legacy record identity does not match its owner")
    if (key.length === 4 && key[3] === "info") {
      const parsed = legacySessionInfo.safeParse(value)
      if (!parsed.success) throw new StorageIntegrityError("Legacy Session metadata is malformed")
      if (parsed.data.scope.id !== key[1])
        throw new StorageIntegrityError("Legacy Session Scope does not match its owner")
    }
  }
}
