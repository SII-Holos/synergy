export function createTargetRequestController() {
  let active: AbortController | undefined

  return {
    start() {
      active?.abort()
      const controller = new AbortController()
      active = controller
      return controller
    },
    finish(controller: AbortController) {
      if (active === controller) active = undefined
    },
    cancel() {
      active?.abort()
      active = undefined
    },
  }
}

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

export function reconcileTargetDraft(input: {
  current: string
  previousServer: string
  nextServer: string
  targetChanged: boolean
}) {
  if (input.targetChanged || input.current === input.previousServer) return input.nextServer
  return input.current
}

export function targetListState(input: { loading: boolean; error: unknown; count: number }) {
  if (input.error) return "error" as const
  if (!input.loading && input.count === 0) return "empty" as const
  return "ready" as const
}
