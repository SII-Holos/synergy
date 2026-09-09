import { Storage } from "../storage/storage"

export function emptyOnNotFound<T>(error: unknown): T[] {
  if (error instanceof Storage.NotFoundError) return []
  throw error
}
