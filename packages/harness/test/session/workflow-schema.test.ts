import { expect, test } from "bun:test"
import { z } from "zod"
import { WorkflowKindRegistry } from "../../src/session/workflow-kind-registry"
import { SessionSchemaRegistry } from "../../src/session/schema-registry"
import { testRuntime } from "../support/runtime"

test("workflow schemas are contributed by selected owners and isolated between runtimes", async () => {
  const schema = SessionSchemaRegistry.compose(z.object({ title: z.string() }))
  await using selected = await testRuntime({
    register() {
      WorkflowKindRegistry.register({
        id: "fixture",
        conflicts: [],
        schema: z.object({ kind: z.literal("fixture"), value: z.string() }),
        async enable() {},
      })
    },
  })
  await using absent = await testRuntime()
  const input = { title: "saved", workflow: { kind: "fixture", value: "retained" } }
  await selected.run(() => expect(schema.parse(input)).toEqual(input))
  await absent.run(() => expect(schema.parse(input)).toEqual({ title: "saved" }))
  await selected.run(() => expect(schema.safeParse({ ...input, workflow: { kind: "absent" } }).success).toBe(false))
})
