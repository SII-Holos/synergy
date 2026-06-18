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
  })

  test("includes /session/index route with operationId session.index", async () => {
    const spec = await Server.openapi()
    const path = spec.paths["/session/index"]
    expect(path).toBeDefined()
    expect(path!.get).toBeDefined()
    expect(path!.get!.operationId).toBe("session.index")
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
})
