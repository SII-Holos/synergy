import { describe, expect, test } from "bun:test"
import type { Session } from "@ericsanchezok/synergy-sdk/client"
import { sortChildSessionsByActivity } from "./status-bar-subsession"

function session(id: string, created: number, updated?: number): Session {
  return {
    id,
    title: id,
    time: {
      created,
      updated,
    },
  } as Session
}

describe("sortChildSessionsByActivity", () => {
  test("orders subsessions by latest activity first", () => {
    const result = sortChildSessionsByActivity([
      session("older-updated", 10, 20),
      session("newer-created", 30),
      session("newest-updated", 1, 40),
    ])

    expect(result.map((item) => item.id)).toEqual(["newest-updated", "newer-created", "older-updated"])
  })
})
