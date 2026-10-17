import { ToolExposure } from "@ericsanchezok/synergy-harness/tool/exposure"
export function registerToolGroup() {
  ToolExposure.registerGroups("note", [
    {
      id: "note",
      title: "Notes",
      description:
        "Create, find and edit project or global notes, evolving plans and research records as long-form documents.",
      tools: ["note_list", "note_read", "note_search", "note_write", "note_edit", "note_archive", "note_delete"],
    },
  ])
}
