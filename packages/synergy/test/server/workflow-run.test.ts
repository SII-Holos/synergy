import { describe, expect, test } from "bun:test"
import { Identifier } from "../../src/id/id"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { Server } from "../../src/server/server"
import { StoragePath } from "../../src/storage/path"
import { Storage } from "../../src/storage/storage"
import { IssueToPrCharter, WorkflowRunService, WorkflowRunStore, type WorkflowTypes } from "../../src/workflow-run"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

function requestPath(directory: string, pathname: string) {
  const url = new URL(pathname, "http://localhost")
  url.searchParams.set("directory", directory)
  return `${url.pathname}${url.search}`
}

async function seedRun(directory: string) {
  const scope = (await Scope.fromDirectory(directory)).scope
  const run = await ScopeContext.provide({
    scope,
    fn: () =>
      WorkflowRunStore.create({
        scopeID: scope.id,
        charterRef: { id: Identifier.ascending("charter"), version: 1 },
        title: "API contract run",
        bossSessionID: Identifier.ascending("session"),
        seats: [],
        maxModelCalls: 10,
      }),
  })
  return { scope, run }
}

describe("workflow run API", () => {
  test("paginates events with an exclusive cursor and a bounded limit", async () => {
    await using tmp = await tmpdir()
    const { scope, run } = await seedRun(tmp.path)
    await ScopeContext.provide({
      scope,
      fn: async () => {
        await WorkflowRunStore.appendEvent(scope.id, run, { kind: "run_paused" })
        await WorkflowRunStore.appendEvent(scope.id, run, { kind: "run_resumed" })
        await WorkflowRunStore.appendEvent(scope.id, run, { kind: "run_cancelled" })
      },
    })

    const app = Server.App()
    const first = await app.request(requestPath(tmp.path, `/workflow-run/run/${run.id}/events?limit=2`))
    expect(first.status).toBe(200)
    const firstPage = (await first.json()) as {
      items: WorkflowTypes.EventInfo[]
      nextCursor?: string
    }
    expect(firstPage.items).toHaveLength(2)
    expect(firstPage.nextCursor).toBe(firstPage.items[1]?.id)

    const second = await app.request(
      requestPath(
        tmp.path,
        `/workflow-run/run/${run.id}/events?limit=2&after=${encodeURIComponent(firstPage.nextCursor!)}`,
      ),
    )
    expect(second.status).toBe(200)
    const secondPage = (await second.json()) as {
      items: WorkflowTypes.EventInfo[]
      nextCursor?: string
    }
    expect(secondPage.items).toHaveLength(2)
    expect(secondPage.items.map((event) => event.id)).not.toContain(firstPage.nextCursor)
    expect(secondPage).not.toHaveProperty("nextCursor")

    const overLimit = await app.request(requestPath(tmp.path, `/workflow-run/run/${run.id}/events?limit=101`))
    expect(overLimit.status).toBe(400)
    expect(await overLimit.json()).toMatchObject({ success: false })
  })

  test("returns the global not-found body for missing GET resources", async () => {
    await using tmp = await tmpdir()
    const app = Server.App()

    for (const pathname of [
      "/workflow-run/run/wfr_missing",
      "/workflow-run/run/wfr_missing/events",
      "/workflow-run/charter/chr_missing/1",
    ]) {
      const response = await app.request(requestPath(tmp.path, pathname))
      expect(response.status).toBe(404)
      const body = (await response.json()) as { name: string; data: { message: string } }
      expect(body.name).toBe("NotFoundError")
      expect(typeof body.data.message).toBe("string")
      expect(body.data.message.includes(tmp.path)).toBe(false)
    }
  })

  test("returns path-safe not-found bodies for missing mutation resources", async () => {
    await using tmp = await tmpdir()
    const requests = [
      Server.App().request(requestPath(tmp.path, "/workflow-run/run/wfr_missing/entity"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Missing" }),
      }),
      Server.App().request(requestPath(tmp.path, "/workflow-run/run/wfr_missing/gate/wfg_missing"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resolution: "continue" }),
      }),
    ]

    for (const response of await Promise.all(requests)) {
      expect(response.status).toBe(404)
      const body = (await response.json()) as { name: string; data: { message: string } }
      expect(body).toMatchObject({ name: "NotFoundError", data: { message: expect.any(String) } })
      expect(JSON.stringify(body)).not.toContain("workflow/runs")
    }
  })

  test("returns workflow transition conflicts as structured 409 errors", async () => {
    await using tmp = await tmpdir()
    const { run } = await seedRun(tmp.path)
    const response = await Server.App().request(requestPath(tmp.path, `/workflow-run/run/${run.id}/gate/wfg_missing`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ resolution: "merge" }),
    })

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({
      name: "WorkflowTransitionRejected",
      data: { reason: "unknown gate wfg_missing" },
    })
  })

  test("returns lifecycle conflicts as structured 409 errors", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = (await Scope.fromDirectory(tmp.path)).scope
    const boss = await ScopeContext.provide({
      scope,
      fn: async () => {
        await IssueToPrCharter.ensureSeeded(scope.id)
        const session = await Session.create({})
        await WorkflowRunService.create({
          charterID: IssueToPrCharter.CHARTER_ID,
          title: "First",
          bossSessionID: session.id,
        })
        return session
      },
    })

    const duplicate = await Server.App().request(requestPath(tmp.path, "/workflow-run/run"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        charterID: IssueToPrCharter.CHARTER_ID,
        title: "Second",
        bossSessionID: boss.id,
      }),
    })
    expect(duplicate.status).toBe(409)
    expect(await duplicate.json()).toMatchObject({ name: "WorkflowTransitionRejected" })

    const { run } = await seedRun(tmp.path)
    await ScopeContext.provide({
      scope,
      fn: () => WorkflowRunStore.update(scope.id, run.id, (draft) => void (draft.status = "paused")),
    })
    const pausedEntity = await Server.App().request(requestPath(tmp.path, `/workflow-run/run/${run.id}/entity`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Too late" }),
    })
    expect(pausedEntity.status).toBe(409)
    expect(await pausedEntity.json()).toMatchObject({ name: "WorkflowTransitionRejected" })

    await ScopeContext.provide({
      scope,
      fn: () => WorkflowRunService.control(run.id, "cancel"),
    })
    const terminalControl = await Server.App().request(requestPath(tmp.path, `/workflow-run/run/${run.id}/control`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "pause" }),
    })
    expect(terminalControl.status).toBe(409)
    expect(await terminalControl.json()).toMatchObject({ name: "WorkflowTransitionRejected" })
  })

  test("marks every JSON request body as required in OpenAPI", async () => {
    const spec = await Server.openapi()
    for (const pathname of [
      "/workflow-run/run",
      "/workflow-run/run/{id}/control",
      "/workflow-run/run/{id}/entity",
      "/workflow-run/run/{id}/gate/{gid}",
    ]) {
      const operation = spec.paths[pathname]?.post as
        | {
            requestBody?: {
              required?: boolean
              content?: Record<string, { schema?: unknown }>
            }
          }
        | undefined
      expect(operation?.requestBody?.required).toBe(true)
      expect(operation?.requestBody?.content?.["application/json"]?.schema).toBeDefined()
    }
  })

  test("publishes pagination bounds and structured workflow conflicts in OpenAPI", async () => {
    const spec = await Server.openapi()
    const eventsOperation = spec.paths["/workflow-run/run/{id}/events"]?.get as
      | {
          parameters?: Array<{
            name?: string
            schema?: { minimum?: number; maximum?: number; default?: number }
          }>
        }
      | undefined
    const limit = eventsOperation?.parameters?.find((parameter) => parameter.name === "limit")
    expect(limit?.schema).toMatchObject({ minimum: 1, maximum: 100, default: 100 })

    const gateOperation = spec.paths["/workflow-run/run/{id}/gate/{gid}"]?.post as
      | {
          responses?: Record<string, { content?: Record<string, { schema?: { $ref?: string } }> }>
        }
      | undefined
    expect(gateOperation?.responses?.["409"]?.content?.["application/json"]?.schema?.$ref).toBe(
      "#/components/schemas/WorkflowConflictError",
    )
  })

  test("uses the global validation error body when a required body is invalid", async () => {
    await using tmp = await tmpdir()
    const response = await Server.App().request(requestPath(tmp.path, "/workflow-run/run"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      success: false,
      errors: expect.any(Array),
    })
  })

  test("rejects invalid charter versions and model-call budgets before service execution", async () => {
    await using tmp = await tmpdir()
    for (const invalid of [{ version: 0 }, { version: 1.5 }, { maxModelCalls: -1 }, { maxModelCalls: 1.5 }]) {
      const response = await Server.App().request(requestPath(tmp.path, "/workflow-run/run"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          charterID: IssueToPrCharter.CHARTER_ID,
          title: "Invalid",
          bossSessionID: "ses_missing",
          ...invalid,
        }),
      })
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({ success: false })
    }

    for (const version of ["0", "1.5"]) {
      const response = await Server.App().request(requestPath(tmp.path, `/workflow-run/charter/cht_invalid/${version}`))
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({ success: false })
    }
  })

  test("delegates unknown exceptions to the global 500 handler", async () => {
    await using tmp = await tmpdir()
    const scope = (await Scope.fromDirectory(tmp.path)).scope
    const runID = Identifier.ascending("workflow_run")
    await Storage.write(StoragePath.workflowRun(Identifier.asScopeID(scope.id), runID), { corrupt: true })

    const response = await Server.App().request(requestPath(tmp.path, "/workflow-run/run"))
    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({
      name: "UnknownError",
      data: { message: "Internal server error" },
    })
  })
})
