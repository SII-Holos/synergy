export async function observeStorageProgress<T, P>(
  operation: (record: (value: P) => void) => Promise<T>,
  report?: (value: P) => void,
): Promise<T> {
  if (!report) return operation(() => {})
  let latest: P | undefined
  let wake = Promise.withResolvers<void>()
  let complete = false
  // Retryable transactions only update bounded in-memory observations; the caller's context owns transport output.
  const pending = operation((value) => {
    latest = value
    wake.resolve()
  }).finally(() => {
    complete = true
    wake.resolve()
  })
  pending.catch(() => {})
  try {
    for (;;) {
      await wake.promise
      if (latest !== undefined) {
        const value = latest
        latest = undefined
        report(value)
      }
      if (complete) return await pending
      wake = Promise.withResolvers<void>()
    }
  } catch (error) {
    await pending.catch(() => {})
    throw error
  }
}
