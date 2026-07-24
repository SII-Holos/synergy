type SettingsSaveOperation = {
  write: () => Promise<void>
  reconcile: () => Promise<void>
  onSuccess: () => void | Promise<void>
  onError: (error: unknown) => void | Promise<void>
}

export function createSettingsSaveQueue() {
  let generation = 0
  let chain = Promise.resolve()

  function supersede() {
    return ++generation
  }

  function isCurrent(target: number) {
    return generation === target
  }

  function enqueue(target: number, operation: SettingsSaveOperation) {
    const run = chain.then(async () => {
      if (!isCurrent(target)) return
      try {
        await operation.write()
        if (!isCurrent(target)) return
        await operation.reconcile()
        if (!isCurrent(target)) return
        await operation.onSuccess()
      } catch (error) {
        if (!isCurrent(target)) return
        await operation.onError(error)
      }
    })
    chain = run.catch(() => {})
    return chain
  }

  return {
    supersede,
    isCurrent,
    enqueue,
  }
}
