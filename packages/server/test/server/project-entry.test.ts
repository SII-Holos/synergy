import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { Server } from "../../src/server/server"
import { testRuntime } from "../support/runtime"

test("directory transport distinguishes hidden=false, pages, empty paths and structured errors", async () => {
  await using runtime = await testRuntime()
  await using directory = await tmpdir()
  await fs.mkdir(path.join(directory.path, "alpha"))
  await fs.mkdir(path.join(directory.path, "beta"))
  await fs.mkdir(path.join(directory.path, ".secret"))
  await runtime.run(async () => {
    const get = (values: Record<string, string>) =>
      Server.App().request(`/global/filesystem/directories?${new URLSearchParams(values)}`)
    const first = await get({ path: directory.path, hidden: "false", limit: "1" })
    expect(first.status).toBe(200)
    const data = await first.json()
    expect(data.entries.map((item: { name: string }) => item.name)).toEqual(["alpha"])
    const next = await get({ path: directory.path, hidden: "false", limit: "1", cursor: data.nextCursor })
    expect((await next.json()).entries.map((item: { name: string }) => item.name)).toEqual(["beta"])
    const empty = await get({ path: path.join(directory.path, "alpha") })
    expect(await empty.json()).toMatchObject({ entries: [], parent: directory.path })
    const missing = await get({ path: path.join(directory.path, "missing") })
    expect(missing.status).toBe(400)
    expect(await missing.json()).toMatchObject({ name: "DirectoryBrowseError", data: { code: "not_found" } })
  })
})

test("session transport validates mutually exclusive locations and reports missing profiles", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    const create = (body: unknown) =>
      Server.App().request("/session?scopeID=home", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })
    expect((await create({ environmentProfile: "native", environmentID: null })).status).toBe(400)
    const missing = await create({ environmentProfile: "not-configured" })
    expect(missing.status).toBe(404)
    expect(await missing.json()).toMatchObject({ data: { message: expect.stringContaining("profile") } })
    const none = await create({ environmentID: null, workspace: { mode: "none" } })
    expect(none.status).toBe(200)
    expect(await none.json()).toMatchObject({ workspaceID: null, environmentID: null })
  })
})
