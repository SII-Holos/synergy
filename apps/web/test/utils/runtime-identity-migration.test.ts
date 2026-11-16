import { afterEach, expect, test } from "bun:test"
import { Persist } from "../../src/utils/persist"
import { migrateRuntimeIdentity } from "../../src/utils/runtime-identity-migration"
import { spaceKey } from "../../src/context/space-state"

const origin = "https://runtime.example"
const first = "94497ff6-b2b3-478e-a3aa-ce77665f0626"
const second = "01487365-5a92-44c6-85bd-3b47c61cb066"
const owner = (id: string) => spaceKey({ kind: "personal", localRuntimeID: id })
const key = (target: ReturnType<typeof Persist.global>) => `${target.storage}:${target.key}`
const draft = (connection: string) =>
  key(Persist.session(Persist.scopeKey(connection, "scope-a"), "session-a", "prompt"))
afterEach(() => localStorage.clear())

test("the first verified Home adopts URL-owned drafts and settings once while keeping newer identity-owned values", () => {
  localStorage.setItem(draft(origin), "legacy draft")
  const fileOwner = (connection: string) => JSON.stringify([connection, "scope-a", "wsp_file", 2])
  const fileKey = (connection: string) => key(Persist.workspace(fileOwner(connection), "file-drafts"))
  localStorage.setItem(fileKey(origin), "unsaved file")
  localStorage.setItem(key(Persist.connection(origin, "notification")), "notifications")
  localStorage.setItem(key(Persist.connection(origin, "layout")), "old layout")
  localStorage.setItem(key(Persist.connection(owner(first), "layout")), "new layout")
  localStorage.setItem(draft("https://another.example"), "another Home")
  expect(migrateRuntimeIdentity({ connection: origin, runtimeID: first })).toEqual({
    key: owner(first),
    adopted: true,
    legacyDefault: false,
  })
  expect(localStorage.getItem(draft(owner(first)))).toBe("legacy draft")
  expect(localStorage.getItem(draft(origin))).toBeNull()
  expect(localStorage.getItem(fileKey(owner(first)))).toBe("unsaved file")
  expect(localStorage.getItem(key(Persist.connection(owner(first), "notification")))).toBe("notifications")
  expect(localStorage.getItem(key(Persist.connection(owner(first), "layout")))).toBe("new layout")
  expect(localStorage.getItem(key(Persist.connection(origin, "layout")))).toBe("old layout")
  expect(localStorage.getItem(draft("https://another.example"))).toBe("another Home")
  expect(migrateRuntimeIdentity({ connection: origin, runtimeID: second })).toEqual({
    key: owner(second),
    adopted: false,
    legacyDefault: false,
  })
  expect(localStorage.getItem(draft(owner(second)))).toBeNull()
  expect(migrateRuntimeIdentity({ connection: "https://moved.example", runtimeID: first }).key).toBe(owner(first))
  expect(localStorage.getItem(draft(owner(first)))).toBe("legacy draft")
})

test("a failed migration keeps its first owner and resumes without deleting the unpromoted draft", () => {
  localStorage.setItem(draft(origin), "unsent draft")
  let full = true
  const storage: Storage = {
    get length() {
      return localStorage.length
    },
    key: (index) => localStorage.key(index),
    getItem: (name) => localStorage.getItem(name),
    setItem(name, value) {
      if (full && name === draft(owner(first))) throw new DOMException("Full", "QuotaExceededError")
      localStorage.setItem(name, value)
    },
    removeItem: (name) => localStorage.removeItem(name),
    clear: () => localStorage.clear(),
  }
  expect(() => migrateRuntimeIdentity({ connection: origin, runtimeID: first }, storage)).toThrow("Full")
  expect(localStorage.getItem(draft(origin))).toBe("unsent draft")
  expect(migrateRuntimeIdentity({ connection: origin, runtimeID: second }).adopted).toBe(false)
  expect(localStorage.getItem(draft(owner(second)))).toBeNull()
  full = false
  expect(migrateRuntimeIdentity({ connection: origin, runtimeID: first }).adopted).toBe(true)
  expect(localStorage.getItem(draft(owner(first)))).toBe("unsent draft")
  expect(localStorage.getItem(draft(origin))).toBeNull()
})

test("unknown migration records and malformed identities never claim or overwrite the old cache", () => {
  const binding = key(Persist.connection(origin, "identity-binding"))
  const newer = JSON.stringify({ version: 2, runtimeID: first })
  localStorage.setItem(binding, newer)
  localStorage.setItem(draft(origin), "preserve")
  expect(() => migrateRuntimeIdentity({ connection: origin, runtimeID: first })).toThrow()
  expect(localStorage.getItem(binding)).toBe(newer)
  expect(localStorage.getItem(draft(origin))).toBe("preserve")
  expect(() => migrateRuntimeIdentity({ connection: origin, runtimeID: "wrong" })).toThrow()
})

test("only the first default personal Home inherits global histories and URL-keyed plugin preferences", () => {
  localStorage.setItem(key(Persist.global("prompt-history")), "older input history")
  localStorage.setItem("model.v1", "older recent models")
  localStorage.setItem(key(Persist.global("locale")), "zh-CN")
  localStorage.setItem(
    key(Persist.global("plugin-shells")),
    JSON.stringify({ version: 1, servers: { [origin]: "plugin:main" } }),
  )
  migrateRuntimeIdentity({ connection: "https://remote.example", runtimeID: second })
  expect(localStorage.getItem(key(Persist.connection(owner(second), "prompt-history")))).toBeNull()
  migrateRuntimeIdentity({ connection: origin, runtimeID: first, legacyDefault: true })
  expect(localStorage.getItem(key(Persist.connection(owner(first), "prompt-history")))).toBe("older input history")
  expect(localStorage.getItem(key(Persist.connection(owner(first), "model")))).toBe("older recent models")
  expect(localStorage.getItem(key(Persist.global("prompt-history")))).toBeNull()
  expect(localStorage.getItem("model.v1")).toBeNull()
  expect(JSON.parse(localStorage.getItem(key(Persist.global("plugin-shells")))!).servers[owner(first)]).toBe(
    "plugin:main",
  )
  localStorage.setItem(key(Persist.global("prompt-history")), "retained older-version history")
  migrateRuntimeIdentity({ connection: "https://new-default.example", runtimeID: second, legacyDefault: true })
  expect(localStorage.getItem(key(Persist.connection(owner(second), "prompt-history")))).toBeNull()
  expect(localStorage.getItem(key(Persist.global("prompt-history")))).toBe("retained older-version history")
  expect(localStorage.getItem(key(Persist.global("locale")))).toBe("zh-CN")
})
