import { describe, expect, test } from "bun:test"
import { Server } from "../../src/server/server"
import { Log } from "../../src/util/log"

Log.init({ print: false })

describe("OpenAPI spec generation", () => {
  test("generates without throwing on z.custom schemas", async () => {
    const spec = await Server.openapi()
    expect(spec).toBeDefined()
    expect(spec.openapi).toBe("3.1.1")
    expect(spec.paths).toBeDefined()
    expect(Object.keys(spec.paths).length).toBeGreaterThan(0)
    const providerResponse = spec.paths["/provider"]?.get as Record<string, any>
    const responseSchema = providerResponse.responses["200"].content["application/json"].schema
    const providerSchema = spec.components?.schemas?.Provider
    const modelSchema = spec.components?.schemas?.Model
    expect(responseSchema.properties.all.items).toEqual({ $ref: "#/components/schemas/Provider" })
    expect(JSON.stringify(providerSchema)).toContain("#/components/schemas/Model")
    expect(JSON.stringify(modelSchema)).toContain("reasoningEfforts")
    expect(JSON.stringify(modelSchema)).not.toContain("reasoning_options")
  })

  test("reuses complete metadata without sharing caller mutations", async () => {
    const first = await Server.openapi()
    const provider = first.components?.schemas?.Provider as Record<string, unknown>
    provider.mutated = true

    const second = await Server.openapi()
    expect(second.components?.schemas?.Provider).toBeDefined()
    expect(second.components?.schemas?.Provider).not.toHaveProperty("mutated")
    expect(JSON.stringify(second.components?.schemas?.Provider)).toContain("#/components/schemas/Model")
  })

  test("includes /session/index route with operationId session.index", async () => {
    const spec = await Server.openapi()
    const path = spec.paths["/session/index"]
    expect(path).toBeDefined()
    expect(path!.get).toBeDefined()
    expect(path!.get!.operationId).toBe("session.index")
  })

  test("includes cursor-paged session messages with a stable operation ID", async () => {
    const spec = await Server.openapi()
    const operation = spec.paths["/session/{sessionID}/message/page"]?.get
    expect(operation?.operationId).toBe("session.messagePage")
    expect(operation?.parameters?.map((item) => ("name" in item ? item.name : undefined))).toEqual([
      "directory",
      "scopeID",
      "sessionID",
      "cursor",
      "limit",
    ])

    const response = operation?.responses?.["200"]
    const schema = JSON.stringify(
      response && "content" in response ? response.content?.["application/json"]?.schema : undefined,
    )
    expect(schema).toContain("SessionMessagePage")
  })

  test("/session/index parameters include scopeID", async () => {
    const spec = await Server.openapi()
    const path = spec.paths["/session/index"]
    const getOp = path!.get! as Record<string, unknown>
    const parameters = getOp.parameters as Array<Record<string, unknown>>
    const scopeIDParam = parameters?.find((p) => p.name === "scopeID")
    expect(scopeIDParam).toBeDefined()
    expect(scopeIDParam!.in).toBe("query")
    expect(scopeIDParam!.required).toBeFalsy()
  })

  test("includes /scope/index route with operationId scope.index", async () => {
    const spec = await Server.openapi()
    const path = spec.paths["/scope/index"]
    expect(path).toBeDefined()
    expect(path!.get).toBeDefined()
    expect(path!.get!.operationId).toBe("scope.index")
  })

  test("includes /note/meta route in the generated spec", async () => {
    const spec = await Server.openapi()
    const paths = spec.paths as Record<string, unknown>
    expect(paths).toHaveProperty("/note/meta")
    const metaPath = paths["/note/meta"] as Record<string, unknown>
    expect(metaPath).toHaveProperty("get")

    const getOp = metaPath.get as Record<string, unknown>
    expect(getOp).toHaveProperty("operationId", "note.listMeta")

    const responses = getOp.responses as Record<string, unknown>
    expect(responses).toHaveProperty("200")
    const resp200 = responses["200"] as Record<string, unknown>
    expect(resp200).toHaveProperty("content")

    const content = resp200.content as Record<string, unknown>
    expect(content).toHaveProperty("application/json")
    const appJson = content["application/json"] as Record<string, unknown>
    expect(appJson).toHaveProperty("schema")

    const schema = JSON.stringify(appJson.schema)
    expect(schema).toContain("MetaScopeGroup")
  })

  test("/note/:id route still in spec with content-carrying schema", async () => {
    const spec = await Server.openapi()
    const paths = spec.paths as Record<string, unknown>
    expect(paths).toHaveProperty("/note/{id}")
    const getPath = paths["/note/{id}"] as Record<string, unknown>
    expect(getPath).toHaveProperty("get")

    const getOp = getPath.get as Record<string, unknown>
    expect(getOp).toHaveProperty("operationId", "note.get")

    const responses = getOp.responses as Record<string, unknown>
    const resp200 = responses["200"] as Record<string, unknown>
    const content = resp200.content as Record<string, unknown>
    const appJson = content["application/json"] as Record<string, unknown>
    const schema = JSON.stringify(appJson.schema)
    expect(schema).toContain("NoteInfo")
  })

  test("includes /global/recent route with operationId global.nav.recent", async () => {
    const spec = await Server.openapi()
    const path = spec.paths["/global/recent"]
    expect(path).toBeDefined()
    expect(path!.get).toBeDefined()
    expect(path!.get!.operationId).toBe("global.nav.recent")
  })

  test("includes /global/pinned route with operationId global.nav.pinned", async () => {
    const spec = await Server.openapi()
    const path = spec.paths["/global/pinned"]
    expect(path).toBeDefined()
    expect(path!.get).toBeDefined()
    expect(path!.get!.operationId).toBe("global.nav.pinned")
  })

  test("includes workspace file platform routes", async () => {
    const spec = await Server.openapi()
    expect(spec.paths["/workspace/files/children"]?.get?.operationId).toBe("workspace.files.children")
    expect(spec.paths["/workspace/files/read"]?.get?.operationId).toBe("workspace.files.read")
    expect(spec.paths["/workspace/files/stat"]?.get?.operationId).toBe("workspace.files.stat")
    expect(spec.paths["/workspace/files/search"]?.get?.operationId).toBe("workspace.files.search")
    expect(spec.paths["/workspace/files/status"]?.get?.operationId).toBe("workspace.files.status")
  })

  test("worktree removal does not expose a session override", async () => {
    const spec = await Server.openapi()
    const schema = spec.components?.schemas?.WorktreeRemoveInput
    expect(schema).toBeDefined()
    expect(schema && "properties" in schema ? schema.properties : undefined).not.toHaveProperty("sessionID")
  })

  test("includes performance observability routes with stable operation IDs", async () => {
    const spec = await Server.openapi()
    expect(spec.paths["/global/performance/summary"]?.get?.operationId).toBe("performance.summary")
    expect(spec.paths["/global/performance/timeline"]?.get?.operationId).toBe("performance.timeline")
    expect(spec.paths["/global/performance/traces"]?.get?.operationId).toBe("performance.traces.list")
    expect(spec.paths["/global/performance/traces/{traceId}"]?.get?.operationId).toBe("performance.traces.detail")
    expect(spec.paths["/global/performance/issues"]?.get?.operationId).toBe("performance.issues.list")
    expect(spec.paths["/global/performance/inflight"]?.get?.operationId).toBe("performance.inflight")
    const inflightParameters = spec.paths["/global/performance/inflight"]?.get?.parameters ?? []
    expect(inflightParameters.map((item) => ("name" in item ? item.name : undefined))).toEqual([
      "scopeID",
      "sessionID",
      "staleMs",
      "limit",
    ])
    expect(spec.paths["/global/performance/config"]?.get?.operationId).toBe("performance.config.get")
    expect(spec.paths["/global/performance/config"]?.patch?.operationId).toBe("performance.config.update")
    expect(spec.paths["/global/performance/browser-metrics"]?.post?.operationId).toBe(
      "performance.browserMetrics.ingest",
    )
    expect(spec.paths["/global/performance/events"]?.get?.operationId).toBe("performance.events.stream")
    expect(spec.paths["/global/performance/analysis"]?.post?.operationId).toBe("performance.analysis.start")
    expect(spec.paths["/global/performance/analysis/{sessionID}"]?.get?.operationId).toBe("performance.analysis.get")
    expect(spec.paths["/global/performance/analysis/{sessionID}/cancel"]?.post?.operationId).toBe(
      "performance.analysis.cancel",
    )
    expect(spec.paths["/global/diagnostics"]?.get?.operationId).toBe("observability.diagnostics.summary")
    const diagnosticsResponse = spec.paths["/global/diagnostics"]?.get?.responses?.["200"]
    const diagnosticsSchema = JSON.stringify(
      diagnosticsResponse && "content" in diagnosticsResponse
        ? diagnosticsResponse.content?.["application/json"]?.schema
        : undefined,
    )
    expect(diagnosticsSchema).toContain("DiagnosticsSummary")
  })

  test("includes Cortex concurrency status with a stable operation ID", async () => {
    const spec = await Server.openapi()
    expect(spec.paths["/cortex/tasks/concurrency"]?.get?.operationId).toBe("cortex.concurrency")
  })

  test("config import routes expose all structured error variants", async () => {
    const spec = await Server.openapi()
    const plan = spec.paths["/config/import/plan"]?.post
    const apply = spec.paths["/config/import/apply"]?.post
    const responseSchema = (operation: typeof plan, status: string) => {
      const response = operation?.responses?.[status] as { content?: Record<string, { schema?: unknown }> } | undefined
      return response?.content?.["application/json"]?.schema
    }

    expect(plan?.operationId).toBe("config.import.plan")
    expect(apply?.operationId).toBe("config.import.apply")
    const planBadRequest = JSON.stringify(responseSchema(plan, "400"))
    expect(planBadRequest).toContain("BadRequestError")
    expect(planBadRequest).toContain("ConfigImportProjectScopeRequiredError")
    expect(planBadRequest).toContain("ConfigImportInvalidConfigError")

    const applyBadRequest = JSON.stringify(responseSchema(apply, "400"))
    expect(applyBadRequest).toContain("BadRequestError")
    expect(applyBadRequest).toContain("ConfigImportProjectScopeRequiredError")
    expect(applyBadRequest).toContain("ConfigImportInvalidConfigError")

    const planPayloadTooLarge = JSON.stringify(responseSchema(plan, "413"))
    expect(planPayloadTooLarge).toContain("ConfigImportSourceTooLargeError")

    const applyPayloadTooLarge = JSON.stringify(responseSchema(apply, "413"))
    expect(applyPayloadTooLarge).toContain("ConfigImportSourceTooLargeError")

    const conflict = JSON.stringify(responseSchema(apply, "409"))
    expect(conflict).toContain("ConfigImportRevisionConflictError")
    expect(conflict).toContain("ConfigImportLockedError")
  })

  test("does not expose legacy file or find routes", async () => {
    const spec = await Server.openapi()
    const paths = Object.keys(spec.paths)
    expect(paths.some((path) => path === "/file" || path.startsWith("/file/"))).toBe(false)
    expect(paths.some((path) => path === "/find" || path.startsWith("/find/"))).toBe(false)
  })

  test("exposes the unified plugin operation route and no interact route", async () => {
    const spec = await Server.openapi()
    const paths = spec.paths as Record<string, unknown>
    expect(paths).toHaveProperty("/plugin/{pluginId}/operations/{operationId}/invoke")
    expect(Object.keys(paths).some((route) => route.includes("/interact"))).toBe(false)
  })
})
