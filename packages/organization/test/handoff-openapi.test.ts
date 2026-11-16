import { expect, test } from "bun:test"
import { organizationOpenApi } from "../src/http"

test("mounted handoff discovery exposes only its named read operations", async () => {
  const spec = await organizationOpenApi()
  for (const [path, operationId, schema] of [
    ["/org/v1/sessions/{sessionID}/handoff-targets", "orgHandoff.targets", "OrgHandoffTargetPage"],
    ["/org/v1/handoffs/{handoffID}/native-target", "orgHandoff.nativeTarget", "OrgHandoffNativeTargetSelection"],
  ]) {
    expect(spec.paths?.[path]?.get).toMatchObject({
      operationId,
      responses: {
        "200": { content: { "application/json": { schema: { $ref: `#/components/schemas/${schema}` } } } },
      },
    })
    expect(spec.paths?.[path]?.post).toBeUndefined()
    expect(spec.components?.schemas?.[schema]).toBeDefined()
  }
})
