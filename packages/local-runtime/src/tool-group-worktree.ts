import { ToolExposure } from "@ericsanchezok/synergy-harness/tool/exposure"
export function registerToolGroup() {
  ToolExposure.registerGroups("local-runtime", [
    {
      id: "worktree",
      title: "Worktree",
      description:
        "Create or enter isolated Git checkouts for parallel work, experiments or PR review without disturbing current changes. List checkouts, return to the main checkout, or archive finished managed worktrees without ending the conversation.",
      tools: ["worktree_enter", "worktree_leave", "worktree_archive", "worktree_list"],
    },
  ])
}
