export namespace WorkflowRunExecutor {
  const tails = new Map<string, Promise<void>>()

  export async function run<T>(scopeID: string, runID: string, task: () => Promise<T>): Promise<T> {
    const key = `${scopeID}:${runID}`
    const previous = tails.get(key) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((resolve) => {
      release = resolve
    })
    const tail = previous.then(() => current)
    tails.set(key, tail)
    await previous
    try {
      return await task()
    } finally {
      release()
      if (tails.get(key) === tail) tails.delete(key)
    }
  }
}
