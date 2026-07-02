import { describe, expect, test } from "bun:test"
import type { Session } from "@ericsanchezok/synergy-sdk/client"
import { childSessionsForParent, sortChildSessionsByActivity } from "./status-bar-subsession"

function session(id: string, created: number, updated?: number, parentID?: string): Session {
  return {
    id,
    title: id,
    parentID,
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

  test("filters children for a parent before sorting", () => {
    const result = childSessionsForParent(
      [
        session("parent", 1),
        session("child-old", 2, 20, "parent"),
        session("child-new", 3, 30, "parent"),
        session("other-child", 4, 40, "other"),
      ],
      "parent",
    )

    expect(result.map((item) => item.id)).toEqual(["child-new", "child-old"])
  })
})
