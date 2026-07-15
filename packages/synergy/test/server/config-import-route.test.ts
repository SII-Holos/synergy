import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Config } from "../../src/config/config"
import { ConfigDomain } from "../../src/config/domain"
import { Server } from "../../src/server/server"
import { tmpdir } from "../fixture/fixture"

function post(app: ReturnType<typeof Server.App>, url: string, body: unknown) {
  return app.request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

describe("config import routes", () => {
  test("plans a project-scoped import through the explicit directory", async () => {
    await using tmp = await tmpdir({ git: true })
    const response = await post(Server.App(), `/config/import/plan?directory=${encodeURIComponent(tmp.path)}`, {
      config: { username: "project-user" },
      scope: "project",
      source: "pasted",
    })

    expect(response.status).toBe(200)
    const plan = await response.json()
    expect(plan).toMatchObject({
      scope: "project",
      source: "pasted",
      revision: expect.stringMatching(/^[a-f0-9]{64}$/),
    })
    expect(plan.domains[0].path).toBe(
      path.join(tmp.path, ".synergy", "synergy.d", ConfigDomain.byId.get("general")!.filename),
    )
  })

  test("applies a project-scoped plan and returns reload results", async () => {
    await using tmp = await tmpdir({ git: true })
    const url = `/config/import/apply?directory=${encodeURIComponent(tmp.path)}`
    const response = await post(Server.App(), url, {
      config: { username: "project-user" },
      scope: "project",
      source: "pasted",
      yes: true,
    })

    expect(response.status).toBe(200)
    const result = await response.json()
    expect(result).toMatchObject({
      plan: { scope: "project", source: "pasted" },
      reload: {
        success: true,
        executed: expect.arrayContaining(["config"]),
        changedFields: expect.arrayContaining(["username"]),
      },
    })
    expect(await Config.domainGet("general", path.join(tmp.path, ".synergy"))).toMatchObject({
      username: "project-user",
    })
  })

  test("returns conflict for a stale project plan", async () => {
    await using tmp = await tmpdir({ git: true })
    const query = `?directory=${encodeURIComponent(tmp.path)}`
    const planned = await post(Server.App(), `/config/import/plan${query}`, {
      config: { username: "imported" },
      scope: "project",
    })
    const plan = await planned.json()
    await Bun.write(
      ConfigDomain.filepath("general", path.join(tmp.path, ".synergy")),
      JSON.stringify({ username: "concurrent" }),
    )

    const response = await post(Server.App(), `/config/import/apply${query}`, {
      config: { username: "imported" },
      scope: "project",
      revision: plan.revision,
      yes: true,
    })

    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ name: "ConfigImportRevisionConflictError" })
  })

  test("returns a structured bad request when conflicts are not confirmed", async () => {
    await using tmp = await tmpdir({ git: true })
    const root = path.join(tmp.path, ".synergy")
    await Config.domainUpdate("general", { username: "existing" }, { root, mode: "replace-domain" })

    const response = await post(Server.App(), `/config/import/apply?directory=${encodeURIComponent(tmp.path)}`, {
      config: { username: "imported" },
      scope: "project",
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ name: "ConfigInvalidError" })
  })

  test("returns a structured conflict while the project import lock is held", async () => {
    await using tmp = await tmpdir({ git: true })
    const directory = ConfigDomain.directory(path.join(tmp.path, ".synergy"))
    await fs.mkdir(directory, { recursive: true })
    await Bun.write(path.join(directory, ".import.lock"), JSON.stringify({ createdAt: Date.now() }))

    const response = await post(Server.App(), `/config/import/apply?directory=${encodeURIComponent(tmp.path)}`, {
      config: { username: "imported" },
      scope: "project",
      yes: true,
    })

    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ name: "ConfigImportLockedError" })
  })

  test("rejects project scope without an explicit project context", async () => {
    const response = await post(Server.App(), "/config/import/plan", {
      config: { username: "project-user" },
      scope: "project",
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ name: "ConfigImportProjectScopeRequiredError" })
  })
})
