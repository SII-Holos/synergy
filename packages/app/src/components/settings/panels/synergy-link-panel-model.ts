export function normalizeAllowedAgents(input: string): string[] {
  return [
    ...new Set(
      input
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ]
}

export function targetFormReady(input: { name: string; targetAgentID: string; linkID: string }): boolean {
  return Boolean(input.name.trim() && input.targetAgentID.trim() && /^link_.+/.test(input.linkID.trim()))
}
