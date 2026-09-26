import { describe, expect, test } from "bun:test"
import { mkdirSync } from "fs"
import path from "path"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { Server } from "../../src/server/server"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()

function patchScope(scopeID: string, body: Record<string, unknown>) {
  return Server.App().request(`/scope/${encodeURIComponent(scopeID)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
}

describe("PATCH /scope/:scopeID sandboxes", () => {
  test("persists sandbox folders and returns them on GET", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      const scope = await tmp.scope()

      const folder1 = path.join(tmp.path, "docs")
      const folder2 = path.join(tmp.path, "src")
      mkdirSync(folder1)
      mkdirSync(folder2)

      const patchResp = await patchScope(scope.id, { sandboxes: [folder1, folder2] })
      expect(patchResp.status).toBe(200)
      const patched = await patchResp.json()
      expect(patched.local.sandboxes).toContain(folder1)
      expect(patched.local.sandboxes).toContain(folder2)

      const getResp = await Server.App().request("/scope")
      expect(getResp.status).toBe(200)
      const scopes = await getResp.json()
      const updated = scopes.find((s: Scope.Project) => s.id === scope.id)
      expect(updated).toBeDefined()
      expect(updated.local.sandboxes).toContain(folder1)
      expect(updated.local.sandboxes).toContain(folder2)
    }))

  test("rejects a relative path with 400", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      const scope = await tmp.scope()

      const resp = await patchScope(scope.id, { sandboxes: ["relative/path"] })
      expect(resp.status).toBe(400)
      const body = await resp.json()
      expect(body.error).toContain("must be absolute")
    }))

  test("rejects a non-existent directory with 400", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      const scope = await tmp.scope()

      const resp = await patchScope(scope.id, { sandboxes: [path.join(tmp.path, "does-not-exist")] })
      expect(resp.status).toBe(400)
      const body = await resp.json()
      expect(body.error).toContain("not a directory")
    }))

  test("rejects a file path with 400", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      const scope = await tmp.scope()
      const filePath = path.join(tmp.path, "README.md")
      await Bun.write(filePath, "# test")

      const resp = await patchScope(scope.id, { sandboxes: [filePath] })
      expect(resp.status).toBe(400)
      const body = await resp.json()
      expect(body.error).toContain("not a directory")
    }))

  test("excludes the worktree itself from the persisted list", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      const scope = await tmp.scope()

      const folder = path.join(tmp.path, "sub")
      mkdirSync(folder)
      // Send the worktree path along with a valid folder
      const resp = await patchScope(scope.id, { sandboxes: [scope.local!.worktree, folder] })
      expect(resp.status).toBe(200)
      const patched = await resp.json()
      // The worktree should be excluded
      expect(patched.local.sandboxes).not.toContain(path.resolve(scope.local!.worktree))
      expect(patched.local.sandboxes).toContain(folder)
    }))

  test("replaces the sandbox list entirely on a second PATCH", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      const scope = await tmp.scope()

      const folder1 = path.join(tmp.path, "docs")
      const folder2 = path.join(tmp.path, "src")
      const folder3 = path.join(tmp.path, "lib")
      mkdirSync(folder1)
      mkdirSync(folder2)
      mkdirSync(folder3)

      // First PATCH with two folders
      const first = await patchScope(scope.id, { sandboxes: [folder1, folder2] })
      expect(first.status).toBe(200)
      expect((await first.json()).local.sandboxes).toHaveLength(2)

      // Second PATCH with a different folder — replaces entirely
      const second = await patchScope(scope.id, { sandboxes: [folder3] })
      expect(second.status).toBe(200)
      expect((await second.json()).local.sandboxes).toEqual([folder3])
    }))

  test("clears the sandbox list when passed an empty array", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      const scope = await tmp.scope()

      const folder = path.join(tmp.path, "docs")
      mkdirSync(folder)

      // Set a sandbox
      await patchScope(scope.id, { sandboxes: [folder] })

      // Clear it
      const clearResp = await patchScope(scope.id, { sandboxes: [] })
      expect(clearResp.status).toBe(200)
      expect((await clearResp.json()).local.sandboxes).toEqual([])
    }))

  test("returns 404 for a non-existent scope", () =>
    runtime.run(async () => {
      const resp = await patchScope("nonexistent_scope_id", { sandboxes: ["/tmp"] })
      expect(resp.status).toBe(404)
    }))
})

function patchScopeByDirectory(scopeID: string, directory: string, body: Record<string, unknown>) {
  const query = directory ? `?directory=${encodeURIComponent(directory)}` : ""
  return Server.App().request(`/scope/${encodeURIComponent(scopeID)}${query}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
}

describe("PATCH /scope/:scopeID identity resolution", () => {
  test("an unknown Scope ID does not register or update the supplied directory", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      const before = await Scope.list()
      const response = await patchScopeByDirectory("unknown_scope_id", tmp.path, { name: "renamed" })
      expect(response.status).toBe(404)
      expect(await response.json()).toMatchObject({ name: "ScopeNotFound" })
      expect(await Scope.list()).toEqual(before)
    }))

  test("an existing Scope ID owns the update even with an unavailable directory hint", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      const scope = await tmp.scope()
      const response = await patchScopeByDirectory(scope.id, path.join(tmp.path, "missing"), { name: "renamed" })
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ id: scope.id, name: "renamed", local: { worktree: tmp.path } })
    }))

  test("an existing Scope ID does not register a competing directory", () =>
    runtime.run(async () => {
      await using first = await tmpdir({ git: true })
      await using second = await tmpdir({ git: true })
      const scope = await first.scope()
      const before = (await Scope.list()).map((entry) => entry.id)
      const response = await patchScopeByDirectory(scope.id, second.path, { name: "renamed" })
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ id: scope.id, name: "renamed" })
      expect((await Scope.list()).map((entry) => entry.id)).toEqual(before)
    }))
})

afterRuntimeTests(() => runtime.close())
