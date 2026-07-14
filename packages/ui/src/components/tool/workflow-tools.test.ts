import { describe, expect, mock, test } from "bun:test"
import { ToolRegistry } from "../tool-registry-lazy"
import { classifyTool } from "./classifier"
import { getWorkflowToolInfo } from "./workflow"

mock.module("../basic-tool", () => ({ BasicTool: () => null }))
mock.module("../tool-output-text", () => ({ ToolTextOutput: () => null }))

await import("./renders/workflow")

const WORKFLOW_TOOL_NAMES = [
  "workflow_status",
  "workflow_run_create",
  "workflow_run_control",
  "workflow_entity_add",
  "workflow_entity_unblock",
  "workflow_gate_resolve",
  "workflow_submit",
  "workflow_block",
  "workflow_charter_draft",
] as const

describe("workflow tool presentation", () => {
  test("classifies every first-party workflow tool with the workflow icon", () => {
    for (const toolName of WORKFLOW_TOOL_NAMES) {
      const classified = classifyTool(toolName)
      expect(classified.category).toBe("workflow")
      expect(classified.spec.icon).toBe("workflow")
    }
  })

  test("provides concise action-specific titles", () => {
    expect(getWorkflowToolInfo("workflow_status", { entityID: "wfe_1" })).toMatchObject({
      icon: "workflow",
      title: "Workflow Status",
      subtitle: "wfe_1",
    })
    expect(getWorkflowToolInfo("workflow_run_create", { title: "Ship release" })).toMatchObject({
      icon: "workflow",
      title: "Create Workflow Run",
      subtitle: "Ship release",
    })
    expect(getWorkflowToolInfo("workflow_run_control", { action: "pause" })).toMatchObject({
      icon: "workflow",
      title: "Pause Workflow Run",
    })
    expect(getWorkflowToolInfo("workflow_entity_add", { title: "Fix parser" })).toMatchObject({
      icon: "workflow",
      title: "Add Workflow Entity",
      subtitle: "Fix parser",
    })
    expect(getWorkflowToolInfo("workflow_entity_unblock", { entityID: "wfe_2" })).toMatchObject({
      icon: "workflow",
      title: "Unblock Workflow Entity",
      subtitle: "wfe_2",
    })
    expect(
      getWorkflowToolInfo("workflow_gate_resolve", { gateInstanceID: "wfg_1", resolution: "merge" }),
    ).toMatchObject({
      icon: "workflow",
      title: "Resolve Workflow Gate",
      subtitle: "wfg_1",
    })
    expect(getWorkflowToolInfo("workflow_submit", { kind: "test_report" })).toMatchObject({
      icon: "workflow",
      title: "Submit Workflow Result",
      subtitle: "test_report",
    })
    expect(getWorkflowToolInfo("workflow_block", { reason: "Waiting for credentials" })).toMatchObject({
      icon: "workflow",
      title: "Block Workflow Entity",
      subtitle: "Waiting for credentials",
    })
    expect(getWorkflowToolInfo("workflow_charter_draft", { name: "Release train", persist: true })).toMatchObject({
      icon: "workflow",
      title: "Draft Workflow Charter",
      subtitle: "Release train",
      args: ["persist"],
    })
  })

  test("registers a first-party renderer for every workflow tool", () => {
    for (const toolName of WORKFLOW_TOOL_NAMES) {
      expect(ToolRegistry.render(toolName)).toBeFunction()
    }
  })
})
