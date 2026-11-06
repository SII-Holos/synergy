import { formatError } from "./error-format"

export type FatalErrorSource = "renderer" | "connection" | "initialization" | "scope"

export interface FatalErrorPresentationAction {
  label: PresentationActionLabel
  run: () => void
}

export type PresentationActionLabel = "reload-interface" | "try-again" | "change-server"

export interface FatalErrorPresentation {
  source: FatalErrorSource
  /** Human-readable label for this category. */
  title: FatalErrorSource
  /** Task-state consequences that affect the recovery action. */
  description?: "renderer" | "connection"
  /** Optional impact guarantee. Only present when the source provides one. */
  impact?: string
  /** Full diagnostic text (includes chain, stack, and structured data). */
  details: string
  /** Primary recovery action. */
  primaryAction: FatalErrorPresentationAction
  /** Optional secondary action (e.g. change-server). */
  secondaryAction?: FatalErrorPresentationAction
}

export interface CreateFatalErrorPresentationInput {
  source: FatalErrorSource
  error: unknown
  onRecover: () => void
  onSecondaryAction?: () => void
}

export function createFatalErrorPresentation(input: CreateFatalErrorPresentationInput): FatalErrorPresentation {
  const details = formatError(input.error)
  const base = { details } as const
  switch (input.source) {
    case "renderer":
      return {
        ...base,
        source: "renderer",
        title: "renderer",
        description: "renderer",
        impact: "reload-interface-only",
        primaryAction: { label: "reload-interface", run: input.onRecover },
      }
    case "connection":
      return {
        ...base,
        source: "connection",
        title: "connection",
        description: "connection",
        primaryAction: { label: "try-again", run: input.onRecover },
        secondaryAction: input.onSecondaryAction ? { label: "change-server", run: input.onSecondaryAction } : undefined,
      }
    case "initialization":
      return {
        ...base,
        source: "initialization",
        title: "initialization",
        primaryAction: { label: "try-again", run: input.onRecover },
      }
    case "scope":
      return {
        ...base,
        source: "scope",
        title: "scope",
        primaryAction: { label: "try-again", run: input.onRecover },
      }
  }
}
