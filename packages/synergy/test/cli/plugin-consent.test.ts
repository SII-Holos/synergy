import { describe, expect, test } from "bun:test"
import type { ApprovalReview } from "../../src/plugin/consent/approval-service"
import type { PluginStatus } from "../../src/plugin/status"
import type { PluginPermissionDiff } from "../../src/plugin/consent/schema"
import {
  approvalSubmitBody,
  formatPluginPermissionDiff,
  pluginInfoStateText,
  pluginStatusText,
} from "../../src/cli/cmd/plugin-consent"

const networkAccess = {
  key: "network.fetch",
  category: "network" as const,
  title: "Network access",
  description: "Fetch external resources",
}
const fileWrites = {
  key: "filesystem.write",
  category: "files" as const,
  title: "File writes",
  description: "Write workspace files",
}
const fileReads = {
  key: "filesystem.read",
  category: "files" as const,
  title: "File reads",
  description: "Read workspace files",
}
const diff: PluginPermissionDiff = {
  pluginId: "truthward",
  fromVersion: "0.1.0",
  toVersion: "0.2.0",
  access: [fileReads, networkAccess],
  added: [networkAccess],
  broadened: [],
  removed: [fileWrites],
  requiresConfirmation: true,
  confirmationReason: "access_expanded",
  reason: "This update expands plugin access.",
}

const review: ApprovalReview = {
  target: { kind: "configured", pluginId: "truthward" },
  pluginId: "truthward",
  name: "TRUTHWARD",
  version: "0.2.0",
  apiVersion: "4.0",
  generation: "generation-2",
  source: "local",
  capabilities: ["filesystem.read", "network.fetch"],
  trust: "declarative",
  access: diff.access,
  added: diff.added,
  broadened: diff.broadened,
  removed: diff.removed,
  requiresConfirmation: true,
  confirmationReason: "access_expanded",
  reason: "This update expands plugin access.",
  reviewToken: "review-token",
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
    operations: [],
    tools: [],
    uiContributions: 0,
    contributionHealth: {},
    ...overrides,
  }
}

describe("plugin approval CLI helpers", () => {
  test("formats the complete permission review", () => {
    const output = formatPluginPermissionDiff(diff).join("\n")

    expect(output).toContain("0.1.0")
    expect(output).toContain("0.2.0")
    expect(output).toContain("Added:")
    expect(output).toContain("Network access")
    expect(output).toContain("Removed:")
    expect(output).toContain("File writes")
    expect(output).not.toContain("Risk")
  })

  test("submits only the canonical target and review token", () => {
    expect(approvalSubmitBody(review)).toEqual({
      target: { kind: "configured", pluginId: "truthward" },
      reviewToken: "review-token",
    })
  })

  test("labels approval-disabled status without losing other phases", () => {
    expect(pluginStatusText(status({ disabledPhase: "approval" }))).toBe("needs confirmation")
    expect(pluginInfoStateText(status({ disabledPhase: "approval" }))).toBe("disabled (needs confirmation)")
    expect(pluginStatusText(status({ disabledPhase: "runtime" }))).toBe("disabled (runtime)")
    expect(pluginStatusText(status({ health: "loaded", loaded: true, disabledPhase: undefined }))).toBe("loaded")
  })
})
