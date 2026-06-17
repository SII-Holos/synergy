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

  test("includes /scope/index route with operationId scope.index", async () => {
    const spec = await Server.openapi()
    const path = spec.paths["/scope/index"]
    expect(path).toBeDefined()
    expect(path!.get).toBeDefined()
    expect(path!.get!.operationId).toBe("scope.index")
  })
})
