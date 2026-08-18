import { describe, expect, test } from "bun:test"
import plugin from "../src/example"

describe("example plugin descriptor", () => {
  test("compiles into a loadable definePlugin() descriptor", () => {
    expect(plugin.id).toBe("example")
    expect(plugin.version).toBe("1.0.0")
    expect(plugin.capabilities).toEqual([{ id: "workspace.read" }])
    expect(plugin.contributions).toHaveLength(2)
  })

  test("declares a workspace-backed operation with a declared capability", () => {
    const operation = plugin.contributions.find((contribution) => contribution.kind === "operation")
    expect(operation).toMatchObject({
      kind: "operation",
      id: "example.get",
      type: "query",
      requires: ["workspace.read"],
    })
  })

  test("declares an event contribution with a string payload", () => {
    expect(plugin.contributions).toContainEqual(expect.objectContaining({ kind: "event", id: "example.changed" }))
  })

  test("runs the example handler against a stub workspace context", async () => {
    const operation = plugin.contributions.find((contribution) => contribution.kind === "operation")
    if (operation?.kind !== "operation") throw new Error("Expected the example operation")
    const read = async (path: string) => (path === "example.txt" ? "hello from example" : undefined)
    const output = await operation.handler({}, { workspace: { read } } as never)
    expect(output).toEqual({ value: "hello from example" })
  })
})
