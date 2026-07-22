import { describe, expect, test } from "bun:test"
import type { Session } from "@ericsanchezok/synergy-sdk/client"
import { findSessionByID, findSessionIndex } from "./session-collection"

function session(id: string, updated: number): Session {
  return {
    id,
    title: id,
    scope: { id: "scope_1", type: "directory", directory: "/project" },
    time: { created: updated, updated },
  } as unknown as Session
}

describe("session collection lookup", () => {
  test("finds sessions by ID when the collection is ordered by recent activity", () => {
    const sessions = [session("ses_z", 300), session("ses_a", 200), session("ses_m", 100)]

    expect(findSessionIndex(sessions, "ses_z")).toBe(0)
    expect(findSessionIndex(sessions, "ses_a")).toBe(1)
    expect(findSessionIndex(sessions, "ses_m")).toBe(2)
    expect(findSessionByID(sessions, "ses_z")).toBe(sessions[0])
  })

  test("returns missing results without assuming an insertion order", () => {
    const sessions = [session("ses_z", 300), session("ses_a", 200)]

    expect(findSessionIndex(sessions, "ses_missing")).toBe(-1)
    expect(findSessionByID(sessions, "ses_missing")).toBeUndefined()
  })
})
