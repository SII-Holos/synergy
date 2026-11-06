import { ToolExposure } from "@ericsanchezok/synergy-harness/tool/exposure"
export function registerToolGroup() {
  ToolExposure.registerGroups("library", [
    {
      id: "memory",
      title: "Memory",
      description:
        "Persist and retrieve durable preferences, identity facts, collaboration rules and technical decisions across sessions. Remember explicit requests and corrected trust boundaries; search prior agreements before revisiting settled decisions. Use Notes for evolving documents, not memory atoms.",
      tools: ["memory_write", "memory_edit", "memory_search", "memory_get"],
    },
  ])
}
