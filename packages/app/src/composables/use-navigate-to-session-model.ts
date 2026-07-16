import type { Navigator } from "@solidjs/router"

export type SessionNavigationIntent = "open" | "return-to-parent"

export type SessionNavigate = Navigator

export function navigateResolvedSession(
  navigate: SessionNavigate,
  input: {
    intent: SessionNavigationIntent
    targetPath: string
    currentPath: string
    from: string | undefined
  },
) {
  if (input.intent === "open") {
    navigate(input.targetPath, { state: { from: input.currentPath } })
    return
  }

  if (input.from === input.targetPath) {
    navigate(-1)
    return
  }

  navigate(input.targetPath, { replace: true })
}
