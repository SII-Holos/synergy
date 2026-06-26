import { describe, expect, test } from "bun:test"
import { $ } from "bun"
import fs from "fs/promises"
import path from "path"
import { Server } from "../../src/server/server"
import { tmpdir } from "../fixture/fixture"

function workspaceUrl(endpoint: string, directory: string, params?: Record<string, string | number | boolean>) {
  const url = new URL(`http://synergy.test/workspace/files/${endpoint}`)
  url.searchParams.set("directory", directory)
  for (const [key, value] of Object.entries(params ?? {})) {
    url.searchParams.set(key, String(value))
  }
  return url.pathname + url.search
}

describe("GET /workspace/files", () => {
  test("requires a Scope instead of silently using home", async () => {
    const app = Server.App()
    const response = await app.request("/workspace/files/children")
    expect(response.status).toBe(400)
    const body = await response.json()
    expect(body.name).toBe("ScopeRequired")
  })

  test("serves children, stat, read, search, and status through the unified route", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await fs.mkdir(path.join(dir, "src"), { recursive: true })
        await Bun.write(path.join(dir, "src", "tracked.ts"), "export const tracked = 1\n")
      },
    })
    await $`git add src/tracked.ts`.cwd(tmp.path).quiet()
    await $`git commit -m baseline`.cwd(tmp.path).quiet()
    await Bun.write(path.join(tmp.path, "src", "tracked.ts"), "export const tracked = 2\n")
    await Bun.write(path.join(tmp.path, "src", "fresh.ts"), "export const fresh = 1\n")

    const app = Server.App()

    const children = await app.request(
      workspaceUrl("children", tmp.path, {
        path: "",
      }),
    )
    expect(children.status).toBe(200)
    const childrenBody = await children.json()
    expect(childrenBody.children.some((node: any) => node.path === "src")).toBe(true)

    const stat = await app.request(workspaceUrl("stat", tmp.path, { path: "src/tracked.ts" }))
    expect(stat.status).toBe(200)
    const statBody = await stat.json()
    expect(statBody.path).toBe("src/tracked.ts")
    expect(statBody.gitStatus).toBe("modified")

    const read = await app.request(workspaceUrl("read", tmp.path, { path: "src/tracked.ts", range: "0:1" }))
    expect(read.status).toBe(200)
    const readBody = await read.json()
    expect(readBody.kind).toBe("text")
    expect(readBody.content).toContain("tracked")

    const search = await app.request(workspaceUrl("search", tmp.path, { kind: "files", query: "fresh" }))
    expect(search.status).toBe(200)
    const searchBody = await search.json()
    expect(searchBody.items.some((item: any) => item.path === "src/fresh.ts")).toBe(true)

    const status = await app.request(workspaceUrl("status", tmp.path))
    expect(status.status).toBe(200)
    const statusBody = await status.json()
    expect(statusBody.files.find((file: any) => file.path === "src/tracked.ts")?.status).toBe("modified")
    expect(statusBody.files.find((file: any) => file.path === "src/fresh.ts")?.status).toBe("untracked")
  })

  test("does not keep compatibility routes for old /file and /find APIs", async () => {
    await using tmp = await tmpdir({ git: true })
    const app = Server.App()

    const file = await app.request(`/file?directory=${encodeURIComponent(tmp.path)}`)
    expect(file.status).toBe(404)

    const find = await app.request(`/find/file?directory=${encodeURIComponent(tmp.path)}&query=src`)
    expect(find.status).toBe(404)
  })
})
