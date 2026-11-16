import { expect, test } from "bun:test"
import type { OrganizationInteractionProtocol as Interaction } from "@ericsanchezok/synergy-organization-protocol"
import { organizationInteractionWindow } from "../../src/organization/interaction-window"
const page = (start: number): Interaction.Pending[] =>
  Array.from({ length: 32 }, (_, index) => ({
    kind: "permission",
    requestID: `permission-${start + index}`,
    sourceSessionID: "session-one",
    permission: "bash",
    patterns: [],
    alwaysScope: "runtime",
  }))
test("polling the first native page cannot evict the last pending page after the continuation is exhausted", () => {
  const first = page(0)
  let current = organizationInteractionWindow({ current: [], incoming: first, mode: "first" })
  for (let start = 32; start < 160; start += 32)
    current = organizationInteractionWindow({ current, incoming: page(start), mode: "more", selected: first[0] })
  expect(current).toHaveLength(128)
  expect(current.filter((row) => row.requestID.startsWith("permission-15"))).toHaveLength(10)
  const ids = current.map((row) => row.requestID)
  const refreshed = page(0).map((row) => ({ ...row, patterns: ["updated"] }))
  current = organizationInteractionWindow({ current, incoming: refreshed, mode: "poll", selected: first[0] })
  expect(current.map((row) => row.requestID)).toEqual(ids)
  const updated = current.find((row) => row.requestID === "permission-0")
  expect(updated?.kind === "permission" ? updated.patterns : undefined).toEqual(["updated"])
  expect(current.at(-1)?.requestID).toBe("permission-159")
})
test("returning to the first page preserves every incoming request and retains an active request separately", () => {
  const selected = page(128).at(-1)!
  const current = organizationInteractionWindow({ current: page(128), incoming: page(0), mode: "first", selected })
  expect(current).toHaveLength(33)
  expect(current.map((row) => row.requestID)).toContain("permission-0")
  expect(current.map((row) => row.requestID)).toContain("permission-159")
  expect(new Set(current.map((row) => row.requestID)).size).toBe(33)
})
