import { createMemo, type Accessor } from "solid-js"
import { createFatalErrorPresentation, type FatalErrorPresentation, type FatalErrorSource } from "./error-presentation"

type FatalErrorPresentationInput = {
  source(): FatalErrorSource
  error(): unknown
  onRecover(): () => void
  onSecondaryAction(): (() => void) | undefined
}

export function createFatalErrorPresentationMemo(input: FatalErrorPresentationInput): Accessor<FatalErrorPresentation> {
  return createMemo(() =>
    createFatalErrorPresentation({
      source: input.source(),
      error: input.error(),
      onRecover: input.onRecover(),
      onSecondaryAction: input.onSecondaryAction(),
    }),
  )
}
