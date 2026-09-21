import { beforeEach, expect, test } from "bun:test"
import { base64Encode, checksum } from "@ericsanchezok/synergy-util/encode"
import { Persist } from "../../src/utils/persist"
import { migrateScopeState } from "../../src/utils/scope-state-migration"

beforeEach(() => localStorage.clear())
const connection = "http://127.0.0.1:4401"
const scope = { id: "project-a", local: { directory: "/repo/a", worktree: "/repo/a", sandboxes: [] } }
const key = (target: { storage?: string; key: string }) => `${target.storage}:${target.key}`

test("moves legacy drafts and layout to their connection and stable Scope without losing current data", () => {
  const directory = base64Encode("/repo/a")
  const legacy = `synergy.workspace.${directory.slice(0, 12)}.${checksum(directory)}.dat:session:session-a:prompt`
  const draft = JSON.stringify({ prompt: [{ type: "text", content: "Unsent work", start: 0, end: 11 }] })
  localStorage.setItem(legacy, draft)
  localStorage.setItem(
    key(Persist.global("layout")),
    JSON.stringify({ sessionView: { [`${directory}/session-a`]: { scroll: { turn: 20 } } }, sidebar: { width: 300 } }),
  )
  migrateScopeState({ connection, scopes: [scope], includeHome: true })
  const target = key(Persist.session(Persist.scopeKey(connection, scope.id), "session-a", "prompt"))
  expect(localStorage.getItem(target)).toBe(draft)
  expect(localStorage.getItem(legacy)).toBeNull()
  expect(JSON.parse(localStorage.getItem(key(Persist.connection(connection, "layout")))!)).toMatchObject({
    sessionView: { [`${base64Encode(scope.id)}/session-a`]: { scroll: { turn: 20 } } },
    sidebar: { width: 300 },
  })
  localStorage.setItem(target, "newer draft")
  migrateScopeState({ connection, scopes: [scope], includeHome: true })
  expect(localStorage.getItem(target)).toBe("newer draft")
})

test("does not assign legacy data to a different server or an unknown project", () => {
  const legacy = `synergy.workspace./repo/missin.${checksum("/repo/missing")}.dat:session:s:prompt`
  localStorage.setItem(legacy, "untouched")
  migrateScopeState({ connection, scopes: [], includeHome: false })
  expect(localStorage.getItem(legacy)).toBe("untouched")
  expect(localStorage.getItem(key(Persist.session(Persist.scopeKey(connection, "home"), "s", "prompt")))).toBeNull()
})

test("an exact local binding wins over another Scope's sandbox alias in either listing order", () => {
  const directory = "/repo/nested"
  const nested = { id: "nested", local: { directory, worktree: directory, sandboxes: [] } }
  const parent = { id: "parent", local: { directory: "/repo", worktree: "/repo", sandboxes: [directory] } }
  const legacy = `synergy.workspace.${directory.slice(0, 12)}.${checksum(directory)}.dat:session:s:prompt`
  for (const scopes of [
    [nested, parent],
    [parent, nested],
  ]) {
    localStorage.clear()
    localStorage.setItem(legacy, "nested draft")
    migrateScopeState({ connection, scopes, includeHome: true })
    expect(localStorage.getItem(key(Persist.session(Persist.scopeKey(connection, nested.id), "s", "prompt")))).toBe(
      "nested draft",
    )
    expect(
      localStorage.getItem(key(Persist.session(Persist.scopeKey(connection, parent.id), "s", "prompt"))),
    ).toBeNull()
  }
})
