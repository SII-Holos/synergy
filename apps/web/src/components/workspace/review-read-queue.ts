export function createReviewReadQueue(limit: number) {
  let running = 0
  const waiting: Array<() => void> = []
  return {
    async run<T>(signal: AbortSignal, read: () => Promise<T>): Promise<T> {
      signal.throwIfAborted()
      if (running >= limit) {
        await new Promise<void>((resolve, reject) => {
          const start = () => {
            signal.removeEventListener("abort", cancel)
            running++
            resolve()
          }
          const cancel = () => {
            const index = waiting.indexOf(start)
            if (index >= 0) waiting.splice(index, 1)
            reject(signal.reason)
          }
          waiting.push(start)
          signal.addEventListener("abort", cancel, { once: true })
        })
      } else running++
      try {
        signal.throwIfAborted()
        return await read()
      } finally {
        running--
        waiting.shift()?.()
      }
    },
  }
}
