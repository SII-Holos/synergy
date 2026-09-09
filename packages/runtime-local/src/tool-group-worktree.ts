import { ToolExposure } from "@ericsanchezok/synergy-harness/tool/exposure"
export function registerToolGroup() {
  ToolExposure.registerGroups("runtime-local", [
    {
      id: "worktree",
      title: "Worktree",
      description:
        "Git worktree management for isolated parallel workspaces. Create independent checkout directories from the same repo (worktree_enter), clean up when done (worktree_leave), and list existing worktrees (worktree_list). Each worktree has its own working directory, index, and local state — ideal for working on multiple branches simultaneously without stashing, running experimental changes in isolation, or reviewing PRs in a clean checkout without contaminating the main workspace.",
      whenToExpand:
        "Expand in these scenarios. (1) You need to work on a separate branch while keeping the current working tree intact — use worktree_enter to create or switch to an isolated checkout. (2) You are about to make experimental, risky, or large-scale changes that should not mutate the current workspace. (3) The user asks you to review a PR, test a branch, or switch context without losing in-progress uncommitted work. (4) The user's prompt mentions 'checkout another branch', 'try this on a clean copy', 'test this branch', 'review PR', 'switch to', or 'worktree'. (5) You are handling multiple independent task streams in parallel and want physical workspace isolation. (6) You previously created a worktree and now need to return to it or clean it up.",
      tools: ["worktree_enter", "worktree_leave", "worktree_list"],
    },
  ])
}
