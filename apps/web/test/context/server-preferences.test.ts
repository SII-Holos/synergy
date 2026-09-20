import { expect, test } from "bun:test"
import { migrateServerPreferences } from "../../src/context/server-preferences"

test("malformed preferences cannot prevent startup or erase valid saved scopes", () => {
  expect(
    migrateServerPreferences({
      list: ["http://server", 42],
      scopes: { local: [null, "bad", { id: "scope-a", expanded: false }, { worktree: "/repo", expanded: true }] },
      legacyScopes: { broken: null },
    }),
  ).toEqual({
    list: ["http://server"],
    scopes: { local: [{ id: "scope-a", expanded: false }] },
    legacyScopes: { local: [{ worktree: "/repo", expanded: true }] },
  })
  expect(migrateServerPreferences(null)).toEqual({ list: [], scopes: {}, legacyScopes: {} })
})
