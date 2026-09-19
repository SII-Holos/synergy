export class AsyncQueue<T> implements AsyncIterable<T> {
  private queue: T[] = []
  private resolvers: ((value: T) => void)[] = []

  push(item: T) {
    const resolve = this.resolvers.shift()
    if (resolve) resolve(item)
    else this.queue.push(item)
  }

  async next(): Promise<T> {
    if (this.queue.length > 0) return this.queue.shift()!
    return new Promise((resolve) => this.resolvers.push(resolve))
  }

  async *[Symbol.asyncIterator]() {
    while (true) yield await this.next()
  }
}

export async function work<T>(concurrency: number, items: T[], fn: (item: T) => Promise<void>) {
  const pending = [...items]
  let failed = false
  const results = await Promise.allSettled(
    Array.from({ length: concurrency }, async () => {
      while (!failed) {
        const item = pending.pop()
        if (item === undefined) return
        try {
          await fn(item)
        } catch (error) {
          failed = true
          throw error
        }
      }
    }),
  )
  const errors = results.filter((result) => result.status === "rejected").map((result) => result.reason)
  if (errors.length === 1) throw errors[0]
  if (errors.length) throw new AggregateError(errors, "Parallel work failed")
}

export async function workMap<T, R>(concurrency: number, items: T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let cursor = 0
  let failed = false
  const settled = await Promise.allSettled(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (!failed && cursor < items.length) {
        const i = cursor++
        try {
          results[i] = await fn(items[i])
        } catch (error) {
          failed = true
          throw error
        }
      }
    }),
  )
  const errors = settled.filter((result) => result.status === "rejected").map((result) => result.reason)
  if (errors.length === 1) throw errors[0]
  if (errors.length) throw new AggregateError(errors, "Parallel work failed")
  return results
}
