import { describe, expect, test } from "bun:test"
import { SynergyLinkExecution } from "../../src/tool/synergy-link-execution"

describe("Synergy Link execution helpers", () => {
  test("omitted linkID is intentional local execution", () => {
    expect(SynergyLinkExecution.resolveExecutionTarget({ linkIDSupplied: false, tool: "bash" })).toEqual({
      kind: "local",
    })
  })

  test("invalid supplied linkID falls back locally with a warning", () => {
    const target = SynergyLinkExecution.resolveExecutionTarget({
      linkID: "env_test",
      linkIDSupplied: true,
      tool: "bash",
    })
    expect(target.kind).toBe("local_fallback")
    if (target.kind === "local_fallback") {
      expect(target.warning.code).toBe("synergy_link.invalid_link_id")
      expect(target.warning.requestedLinkID).toBe("env_test")
    }
  })

  test("valid linkID with no client falls back locally as not connected", () => {
    SynergyLinkExecution.setClient(null)
    const target = SynergyLinkExecution.resolveExecutionTarget({
      linkID: "link_test",
      linkIDSupplied: true,
      tool: "process",
    })
    expect(target.kind).toBe("local_fallback")
    if (target.kind === "local_fallback") {
      expect(target.warning.code).toBe("synergy_link.not_connected")
    }
  })

  test("warning helper prepends visible output and preserves metadata", () => {
    const result = SynergyLinkExecution.withLocalFallbackWarning(
      { title: "ok", metadata: { backend: "local" } as Record<string, unknown>, output: "done" },
      {
        code: "synergy_link.invalid_link_id",
        message: 'Requested linkID "env" is invalid, so this operation ran locally.',
        reminder: "Omit linkID for intentional local execution.",
        requestedLinkID: "env",
        retryable: false,
      },
    )
    expect(result.output).toContain("Synergy Link warning")
    expect(result.output).toContain("done")
    expect(result.metadata.warnings).toHaveLength(1)
  })
})
