import { expect, test } from "bun:test"
import { ObservabilityStore } from "../../src/observability/store"
import { PermissionNext } from "../../src/permission/next"

test("permission evaluation emits bounded telemetry without rule contents", () => {
  const permission = `telemetry-test-${crypto.randomUUID()}`
  const sensitivePattern = `secret-pattern-${crypto.randomUUID()}`
  const ruleset: PermissionNext.Ruleset = [
    ...Array.from({ length: 256 }, (_, index) => ({
      permission,
      pattern: `${sensitivePattern}-${index}`,
      action: "ask" as const,
    })),
    { permission, pattern: sensitivePattern, action: "allow" },
  ]

  expect(PermissionNext.evaluate(permission, sensitivePattern, ruleset).action).toBe("allow")

  const event = ObservabilityStore.queryEvents({ type: "log.record" }).find((item) => {
    const data = JSON.parse(item.data_json) as Record<string, unknown>
    return data.permission === permission
  })
  expect(event).toBeDefined()

  const data = JSON.parse(event!.data_json) as Record<string, unknown>
  expect(data).toMatchObject({
    service: "permission",
    message: "evaluate",
    permission,
    patternLength: sensitivePattern.length,
    rulesetCount: ruleset.length,
  })
  expect(data).not.toHaveProperty("pattern")
  expect(data).not.toHaveProperty("ruleset")
  expect(JSON.stringify(data)).not.toContain(sensitivePattern)
  expect(JSON.stringify(data).length).toBeLessThan(256)
})
