type Queue = { owner: object; pending: Promise<void> }
const bridges = new WeakMap<object, Map<string, Queue>>()

export function claimNativeView(bridge: object, key: string) {
  let views = bridges.get(bridge)
  if (!views) {
    views = new Map()
    bridges.set(bridge, views)
  }
  const owner = {}
  const queue = views.get(key) ?? { owner, pending: Promise.resolve() }
  queue.owner = owner
  views.set(key, queue)
  let active = true
  const enqueue = (run: () => void | Promise<unknown>, closing = false) => {
    const result = queue.pending.then(async () => {
      if (queue.owner === owner && (active || closing)) await run()
    })
    const pending = result
      .catch(() => {})
      .finally(() => {
        if (!active && queue.owner === owner && queue.pending === pending) views!.delete(key)
      })
    queue.pending = pending
    return result
  }
  return {
    run: (run: () => void | Promise<unknown>) => enqueue(run),
    release(run: () => void | Promise<unknown>) {
      if (!active) return Promise.resolve()
      active = false
      return enqueue(run, true)
    },
  }
}
