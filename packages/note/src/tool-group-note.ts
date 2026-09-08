import { ToolExposure } from "@ericsanchezok/synergy-harness/tool/exposure"
export function registerToolGroup() {
  ToolExposure.registerGroups("note", [
    {
      id: "note",
      title: "Notes",
      description:
        "Project and global long-form notes, Blueprint notes, evolving plans, research records, and structured note edits.",
      whenToExpand:
        "Expand when information should live as an editable document, when reading or writing Blueprint notes, or when a task asks for stored project/global notes.",
      tools: ["note_list", "note_read", "note_search", "note_write", "note_edit", "note_archive", "note_delete"],
    },
  ])
}
