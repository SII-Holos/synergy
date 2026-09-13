export namespace Lock {
  const locks = new Map<
    string,
    {
      readers: number
      writer: boolean
      waitingReaders: (() => void)[]
      waitingWriters: (() => void)[]
    }
  >()

  function get(key: string) {
    if (!locks.has(key)) {
      locks.set(key, {
        readers: 0,
        writer: false,
        waitingReaders: [],
        waitingWriters: [],
      })
    }
    return locks.get(key)!
  }

  function process(key: string) {
    const lock = locks.get(key)
    if (!lock || lock.writer || lock.readers > 0) return

    // Prioritize writers to prevent starvation
    if (lock.waitingWriters.length > 0) {
      const nextWriter = lock.waitingWriters.shift()!
      nextWriter()
      return
    }

    // Wake up all waiting readers
    while (lock.waitingReaders.length > 0) {
      const nextReader = lock.waitingReaders.shift()!
      nextReader()
    }

    // Clean up empty locks
    if (lock.readers === 0 && !lock.writer && lock.waitingReaders.length === 0 && lock.waitingWriters.length === 0) {
      locks.delete(key)
    }
  }

  export async function read(key: string): Promise<Disposable> {
    const lock = get(key)

    return new Promise((resolve) => {
      if (!lock.writer && lock.waitingWriters.length === 0) {
        lock.readers++
        resolve({
          [Symbol.dispose]: () => {
            lock.readers--
            process(key)
          },
        })
      } else {
        lock.waitingReaders.push(() => {
          lock.readers++
          resolve({
            [Symbol.dispose]: () => {
              lock.readers--
              process(key)
            },
          })
        })
      }
    })
  }

  export async function write(key: string): Promise<Disposable> {
    const lock = get(key)

    return new Promise((resolve) => {
      if (!lock.writer && lock.readers === 0) {
        lock.writer = true
        resolve({
          [Symbol.dispose]: () => {
            lock.writer = false
            process(key)
          },
        })
      } else {
        lock.waitingWriters.push(() => {
          lock.writer = true
          resolve({
            [Symbol.dispose]: () => {
              lock.writer = false
              process(key)
            },
          })
        })
      }
    })
  }

  /**
   * Acquire the write lock, abandoning the wait when the signal aborts.
   * Resolves undefined when the signal is already aborted or aborts while
   * queued; a waiter abandoned that way is removed from the queue so a later
   * release cannot grant a lock whose owner will never run. Callers that
   * acquire while a simultaneous abort lands still observe it through their
   * own signal check after acquisition.
   */
  export async function writeWithSignal(key: string, signal: AbortSignal): Promise<Disposable | undefined> {
    const lock = get(key)
    if (signal.aborted) return undefined

    if (!lock.writer && lock.readers === 0) {
      lock.writer = true
      return {
        [Symbol.dispose]: () => {
          lock.writer = false
          process(key)
        },
      }
    }

    return new Promise((resolve) => {
      const acquire = () => {
        signal.removeEventListener("abort", onAbort)
        lock.writer = true
        resolve({
          [Symbol.dispose]: () => {
            lock.writer = false
            process(key)
          },
        })
      }
      const onAbort = () => {
        const queued = lock.waitingWriters.indexOf(acquire)
        if (queued >= 0) lock.waitingWriters.splice(queued, 1)
        resolve(undefined)
      }
      lock.waitingWriters.push(acquire)
      signal.addEventListener("abort", onAbort, { once: true })
    })
  }

  /**
   * Try to acquire the write lock without waiting. Returns undefined when
   * the lock is currently held (by a writer or any reader), in which case
   * the caller should skip the guarded work instead of queuing. When the
   * key is idle the lock is acquired immediately (a fresh entry is created
   * and cleaned up again on dispose, matching Lock.write semantics).
   */
  export async function tryAcquireWrite(key: string): Promise<Disposable | undefined> {
    const lock = get(key)
    if (lock.writer || lock.readers > 0) return undefined
    lock.writer = true
    return {
      [Symbol.dispose]: () => {
        lock.writer = false
        process(key)
      },
    }
  }
}
