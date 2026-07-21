import { describe, expect, test } from "bun:test"
import type { ApprovalReview } from "../../src/plugin/consent/approval-service"
import type { PluginStatus } from "../../src/plugin/status"
import {
  approvalSubmitBody,
  formatPluginPermissionDiff,
  pluginInfoStateText,
  pluginStatusText,
} from "../../src/cli/cmd/plugin-consent"

const review: ApprovalReview = {
  target: { kind: "configured", pluginId: "truthward" },
  pluginId: "truthward",
  name: "TRUTHWARD",
  version: "0.2.0",
  capabilities: ["filesystem.read", "network.fetch"],
  risk: "high",
  trust: "declarative",
  permissionsChanged: true,
  reason: "Permission changes detected between versions.",
  reviewToken: "review-token",
  diff: {
    pluginId: "truthward",
    fromVersion: "0.1.0",
    toVersion: "0.2.0",
    riskBefore: "medium",
    riskAfter: "high",
    added: [
      {
        key: "network.fetch",
        category: "network",
        severity: "high",
        title: "Network access",
        description: "Fetch external resources",
      },
    ],
    removed: [
      {
        key: "filesystem.write",
        category: "files",
        severity: "high",
        title: "File writes",
        description: "Write workspace files",
      },
    ],
    unchanged: [
      {
        key: "filesystem.read",
        category: "files",
        severity: "medium",
        title: "File reads",
        description: "Read workspace files",
      },
    ],
    changed: [{ key: "filesystem.read", before: "low", after: "medium" }],
    requiresApproval: true,
    reason: "Permission changes detected between versions.",
  },
}

function status(overrides: Partial<PluginStatus>): PluginStatus {
  return {
    id: "truthward",
    name: "TRUTHWARD",
    version: "0.2.0",
    installation: { kind: "directory", spec: "file:///plugin", path: "/plugin" },
    trust: "declarative",
    health: "disabled",
    loaded: false,
    capabilities: ["filesystem.read"],
    risk: "medium",
    operations: [],
    tools: [],
    uiContributions: 0,
    contributionHealth: {},
    ...overrides,
  }
}

describe("plugin approval CLI helpers", () => {
  test("formats the complete permission review", () => {
    const output = formatPluginPermissionDiff(review.diff).join("\n")

    expect(output).toContain("0.1.0")
    expect(output).toContain("0.2.0")
    expect(output).toContain("Added:")
    expect(output).toContain("Network access")
    expect(output).toContain("Removed:")
    expect(output).toContain("File writes")
    expect(output).toContain("Unchanged:")
    expect(output).toContain("File reads")
    expect(output).toContain("Changed severity:")
    expect(output).toContain("filesystem.read")
  })

  test("submits only the canonical target and review token", () => {
    expect(approvalSubmitBody(review)).toEqual({
      target: { kind: "configured", pluginId: "truthward" },
      reviewToken: "review-token",
    })
  })

  test("labels approval-disabled status without losing other phases", () => {
    expect(pluginStatusText(status({ disabledPhase: "approval" }))).toBe("needs approval")
    expect(pluginInfoStateText(status({ disabledPhase: "approval" }))).toBe("disabled (needs approval)")
    expect(pluginStatusText(status({ disabledPhase: "runtime" }))).toBe("disabled (runtime)")
    expect(pluginStatusText(status({ health: "loaded", loaded: true, disabledPhase: undefined }))).toBe("loaded")
  })
})
