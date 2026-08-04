import { describe, expect, test } from "bun:test"
import { mkdirSync } from "fs"
import path from "path"
import { tmpdir } from "../fixture/fixture"
import { Scope } from "../../src/scope"
import { Server } from "../../src/server/server"

function patchScope(scopeID: string, body: Record<string, unknown>) {
  return Server.App().request(`/scope/${encodeURIComponent(scopeID)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
}

describe("PATCH /scope/:scopeID sandboxes", () => {
  test("persists sandbox folders and returns them on GET", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    const folder1 = path.join(tmp.path, "docs")
    const folder2 = path.join(tmp.path, "src")
    mkdirSync(folder1)
    mkdirSync(folder2)

    const patchResp = await patchScope(scope.id, { sandboxes: [folder1, folder2] })
    expect(patchResp.status).toBe(200)
    const patched = await patchResp.json()
    expect(patched.sandboxes).toContain(folder1)
    expect(patched.sandboxes).toContain(folder2)

    const getResp = await Server.App().request("/scope")
    expect(getResp.status).toBe(200)
    const scopes = await getResp.json()
    const updated = scopes.find((s: Scope.Project) => s.id === scope.id)
    expect(updated).toBeDefined()
    expect(updated.sandboxes).toContain(folder1)
    expect(updated.sandboxes).toContain(folder2)
  })

  test("rejects a relative path with 400", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    const resp = await patchScope(scope.id, { sandboxes: ["relative/path"] })
    expect(resp.status).toBe(400)
    const body = await resp.json()
    expect(body.error).toContain("must be absolute")
  })

  test("rejects a non-existent directory with 400", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    const resp = await patchScope(scope.id, { sandboxes: [path.join(tmp.path, "does-not-exist")] })
    expect(resp.status).toBe(400)
    const body = await resp.json()
    expect(body.error).toContain("not a directory")
  })

  test("rejects a file path with 400", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    const filePath = path.join(tmp.path, "README.md")
    await Bun.write(filePath, "# test")

    const resp = await patchScope(scope.id, { sandboxes: [filePath] })
    expect(resp.status).toBe(400)
    const body = await resp.json()
    expect(body.error).toContain("not a directory")
  })

  test("excludes the worktree itself from the persisted list", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    const folder = path.join(tmp.path, "sub")
    mkdirSync(folder)
    // Send the worktree path along with a valid folder
    const resp = await patchScope(scope.id, { sandboxes: [scope.worktree, folder] })
    expect(resp.status).toBe(200)
    const patched = await resp.json()
    // The worktree should be excluded
    expect(patched.sandboxes).not.toContain(path.resolve(scope.worktree))
    expect(patched.sandboxes).toContain(folder)
  })

  test("replaces the sandbox list entirely on a second PATCH", async () => {
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
    expect((await first.json()).sandboxes).toHaveLength(2)

    // Second PATCH with a different folder — replaces entirely
    const second = await patchScope(scope.id, { sandboxes: [folder3] })
    expect(second.status).toBe(200)
    expect((await second.json()).sandboxes).toEqual([folder3])
  })

  test("clears the sandbox list when passed an empty array", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    const folder = path.join(tmp.path, "docs")
    mkdirSync(folder)

    // Set a sandbox
    await patchScope(scope.id, { sandboxes: [folder] })

    // Clear it
    const clearResp = await patchScope(scope.id, { sandboxes: [] })
    expect(clearResp.status).toBe(200)
    expect((await clearResp.json()).sandboxes).toEqual([])
  })

  test("returns 404 for a non-existent scope", async () => {
    const resp = await patchScope("nonexistent_scope_id", { sandboxes: ["/tmp"] })
    expect(resp.status).toBe(404)
  })
})
