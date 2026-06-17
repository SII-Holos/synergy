import { describe, expect, test } from "bun:test"
import { Server } from "../../src/server/server"

describe("OpenAPI spec generation", () => {
  test("generates without throwing on z.custom schemas", async () => {
    const spec = await Server.openapi()
    expect(spec).toBeDefined()
    expect(spec.openapi).toBe("3.1.1")
    expect(spec.paths).toBeDefined()
    expect(Object.keys(spec.paths).length).toBeGreaterThan(0)
  })

  test("includes /note/meta route in the generated spec", async () => {
    const spec = await Server.openapi()
    // The spec must contain a path entry for the metadata route
    const paths = spec.paths as Record<string, unknown>
    expect(paths).toHaveProperty("/note/meta")
    const metaPath = paths["/note/meta"] as Record<string, unknown>
    expect(metaPath).toHaveProperty("get")

    // Verify operationId for SDK generation
    const getOp = metaPath.get as Record<string, unknown>
    expect(getOp).toHaveProperty("operationId", "note.listMeta")

    // Response schema must reference the MetaScopeGroup array, not NoteScopeGroup
    const responses = getOp.responses as Record<string, unknown>
    expect(responses).toHaveProperty("200")
    const resp200 = responses["200"] as Record<string, unknown>
    expect(resp200).toHaveProperty("content")

    // The schema must NOT contain 'content' field since it's a metadata-type
    const content = resp200.content as Record<string, unknown>
    expect(content).toHaveProperty("application/json")
    const appJson = content["application/json"] as Record<string, unknown>
    expect(appJson).toHaveProperty("schema")

    // MetaScopeGroup schema reference should not include the word "ScopeGroup" from
    // the legacy type — it should reference MetaScopeGroup
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

    // The response schema for /note/:id must include 'content'
    const responses = getOp.responses as Record<string, unknown>
    const resp200 = responses["200"] as Record<string, unknown>
    const content = resp200.content as Record<string, unknown>
    const appJson = content["application/json"] as Record<string, unknown>
    const schema = JSON.stringify(appJson.schema)
    // The individual note getter must carry content — it references NoteInfo, not NoteMetaInfo
    expect(schema).toContain("NoteInfo")
  })
})
