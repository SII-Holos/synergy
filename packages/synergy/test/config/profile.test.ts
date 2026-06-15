import { test, expect, describe, beforeAll, afterAll } from "bun:test"
import { mkdtempSync, rmSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import type { ProfileMeta } from "../../src/config/profile-schema"

const tmpDir = mkdtempSync(join(import.meta.dirname, "..", ".tmp-profile-"))

// Dynamically import profile with a custom test home so Global.Path.config
// and Global.Path.state point to the temp directory.
const origHome = process.env["SYNERGY_TEST_HOME"]
let profileMod: typeof import("../../src/config/profile")

beforeAll(async () => {
  process.env["SYNERGY_TEST_HOME"] = tmpDir
  profileMod = await import("../../src/config/profile")
})

afterAll(() => {
  if (origHome !== undefined) {
    process.env["SYNERGY_TEST_HOME"] = origHome
  } else {
    delete process.env["SYNERGY_TEST_HOME"]
  }
  rmSync(tmpDir, { recursive: true, force: true })
})

function makeMeta(overrides: Partial<ProfileMeta> = {}): ProfileMeta {
  return {
    name: "test",
    ...overrides,
  }
}

describe("profile", () => {
  test("list returns empty when no profiles", async () => {
    const result = await profileMod.list()
    expect(result).toEqual([])
  })

  test("create + list shows the profile", async () => {
    await profileMod.create("dev", makeMeta({ name: "dev", description: "Dev profile" }))

    const profiles = await profileMod.list()
    expect(profiles).toHaveLength(1)
    expect(profiles[0]).toMatchObject({
      name: "dev",
      description: "Dev profile",
    })
  })

  test("list returns multiple profiles sorted by name", async () => {
    await profileMod.create("zzz", makeMeta({ name: "zzz" }))
    await profileMod.create("aaa", makeMeta({ name: "aaa" }))

    const profiles = await profileMod.list()
    // profiles should be sorted alphabetically by name
    const names = profiles.map((p) => p.name)
    expect(names).toEqual(names.slice().sort())
  })

  test("resolve returns empty object when profile has no config file", async () => {
    await profileMod.create("bare", makeMeta({ name: "bare" }))
    const resolved = await profileMod.resolve("bare")
    expect(resolved).toEqual({})
  })

  test("resolve returns the profile's config content", async () => {
    await profileMod.create("with-config", makeMeta({ name: "with-config" }))

    // Write config to the profile's synergy.jsonc
    const fs = await import("node:fs/promises")
    const path = await import("node:path")
    const configDir = path.join(tmpDir, ".synergy", "config", "profiles", "with-config")
    await Bun.write(path.join(configDir, "synergy.jsonc"), JSON.stringify({ model: "test/model", theme: "dark" }))

    const resolved = await profileMod.resolve("with-config")
    expect(resolved).toEqual({ model: "test/model", theme: "dark" })
  })

  test("resolve walks inheritance chain — parent first, child overrides", async () => {
    const fs = await import("node:fs/promises")
    const path = await import("node:path")
    const profilesBase = path.join(tmpDir, ".synergy", "config", "profiles")

    // Create parent profile
    await profileMod.create("parent", makeMeta({ name: "parent" }))
    await Bun.write(
      path.join(profilesBase, "parent", "synergy.jsonc"),
      JSON.stringify({ model: "parent-model", theme: "dark", onlyParent: true }),
    )

    // Create child profile that inherits from parent
    await profileMod.create("child", makeMeta({ name: "child", inherits: "parent" }))
    await Bun.write(path.join(profilesBase, "child", "synergy.jsonc"), JSON.stringify({ model: "child-model" }))

    const resolved = await profileMod.resolve("child")
    expect(resolved).toEqual({
      model: "child-model", // child override takes precedence
      theme: "dark", // inherited from parent
      onlyParent: true, // inherited from parent
    })
  })

  test("deep merge works correctly in inheritance", async () => {
    const fs = await import("node:fs/promises")
    const path = await import("node:path")
    const profilesBase = path.join(tmpDir, ".synergy", "config", "profiles")

    // Parent with nested config
    await profileMod.create("deep-parent", makeMeta({ name: "deep-parent" }))
    await Bun.write(
      path.join(profilesBase, "deep-parent", "synergy.jsonc"),
      JSON.stringify({
        model: "parent-model",
        nested: { a: 1, b: 2 },
        array: "parent",
      }),
    )

    // Child overrides nested
    await profileMod.create("deep-child", makeMeta({ name: "deep-child", inherits: "deep-parent" }))
    await Bun.write(
      path.join(profilesBase, "deep-child", "synergy.jsonc"),
      JSON.stringify({
        nested: { b: 20, c: 3 },
        array: "child",
      }),
    )

    const resolved = await profileMod.resolve("deep-child")
    expect(resolved).toEqual({
      model: "parent-model", // inherited
      nested: { a: 1, b: 20, c: 3 }, // deep merge: child.b overrides parent.b, child.c added
      array: "child", // child value wins (remeda mergeDeep replaces primitives)
    })
  })

  test("create is idempotent — does not overwrite existing synergy.jsonc", async () => {
    const fs = await import("node:fs/promises")
    const path = await import("node:path")
    const profilesBase = path.join(tmpDir, ".synergy", "config", "profiles")

    // Create profile and write custom config
    await profileMod.create("idempotent-check", makeMeta({ name: "idempotent-check" }))
    await Bun.write(path.join(profilesBase, "idempotent-check", "synergy.jsonc"), JSON.stringify({ custom: true }))

    // Calling create again should not overwrite the config
    await profileMod.create("idempotent-check", makeMeta({ name: "idempotent-check" }))
    const resolved = await profileMod.resolve("idempotent-check")
    expect(resolved).toEqual({ custom: true })
  })
})
