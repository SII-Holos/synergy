import CONTENT from "./content.txt"

export const gitGuide = {
  name: "git-guide",
  description:
    "Git expert for commits, rebase, and history search. Use for: atomic commits (auto-detects style from repo), rebase/squash, history archaeology (blame, bisect, log -S). Triggers: 'commit', 'rebase', 'squash', 'who wrote', 'when was X added', 'find the commit that', 'git blame'.",
  content: CONTENT,
  builtin: true as const,
}
