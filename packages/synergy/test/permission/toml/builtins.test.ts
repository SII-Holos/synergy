import { test, expect } from "bun:test"
import { TomlBuiltins } from "../../../src/permission/toml/builtins"

test(":read-only returns profile", () => {
  const profile = TomlBuiltins.get(":read-only")
  expect(profile).toBeDefined()
  expect(profile).not.toBeNull()
  if (!profile) return
  expect(profile.description).toBeDefined()
  expect(profile.filesystem).toBeDefined()
  expect(profile.filesystem?.write).toBeUndefined()
  expect(profile.network).toBeDefined()
  expect(profile.network?.enabled).toBe(false)
})

test(":workspace returns profile", () => {
  const profile = TomlBuiltins.get(":workspace")
  expect(profile).toBeDefined()
  expect(profile).not.toBeNull()
  if (!profile) return
  expect(profile.filesystem).toBeDefined()
  expect(profile.filesystem?.read).toEqual([":workspace"])
  expect(profile.filesystem?.write).toEqual([":workspace"])
})

test(":danger-full-access returns profile", () => {
  const profile = TomlBuiltins.get(":danger-full-access")
  expect(profile).toBeDefined()
  expect(profile).not.toBeNull()
  if (!profile) return
  expect(profile.filesystem).toBeDefined()
  expect(profile.filesystem?.read).toEqual([":root"])
  expect(profile.filesystem?.write).toEqual([":root"])
  expect(profile.network).toBeDefined()
  expect(profile.network?.enabled).toBe(true)
})

test("unknown builtin returns undefined", () => {
  const profile = TomlBuiltins.get(":nonexistent")
  expect(profile).toBeUndefined()
})
