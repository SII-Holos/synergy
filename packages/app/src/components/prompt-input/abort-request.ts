export interface AbortRequestInput {
  request: () => Promise<void>
  setPending: (pending: boolean) => void
}

export interface AbortRequestController {
  run: () => Promise<void>
}

export function createAbortRequestController(input: AbortRequestInput): AbortRequestController {
  let pendingPromise: Promise<void> | null = null

  const run = (): Promise<void> => {
    if (pendingPromise) return pendingPromise

    input.setPending(true)
    pendingPromise = input.request().then(
      () => {
        input.setPending(false)
        pendingPromise = null
      },
      (err) => {
        input.setPending(false)
        pendingPromise = null
        throw err
      },
    )
    return pendingPromise
  }

  return { run }
}
