type Stage =
  | "native-producer"
  | "part-flush"
  | "native-migrations"
  | "projection-drain"
  | "first-share"
  | "first-batch"
  | "first-drain"
  | "first-history"
  | "tail-native"
  | "tail-events"
  | "unshare"
  | "reshare"
  | "second-batch"
  | "second-drain"
  | "second-history"
  | "completed"
type Queue = {
  projections?: number
  drafts?: number
  ordered?: number
  pendingBatches?: number
  nativeDeliveriesInStore?: number
}

export function observeSyncWindow(kind: "live" | "generation", messages: () => number) {
  const started = performance.now()
  const transactions = new WeakSet<object>()
  const nativeTransactions = new WeakSet<object>()
  let transactionCallbacks = 0
  let nativeTransactionCallbacks = 0
  let stage: Stage = "native-producer"
  let queues: Queue = {}
  let queueObservedAtMs: number | undefined
  function emit() {
    console.error(
      "SYNC_WINDOW_PHASE",
      JSON.stringify({
        kind,
        stage,
        elapsedMs: performance.now() - started,
        messageCalls: messages(),
        transactionCallbacks,
        nativeTransactionCallbacks,
        queueObservedAtMs,
        ...queues,
      }),
    )
  }
  const interval = setInterval(emit, 2000)
  interval.unref()
  return {
    stage(value: Stage) {
      stage = value
      emit()
    },
    queue(value: Queue) {
      queues = value
      queueObservedAtMs = performance.now() - started
    },
    transaction(tx: object) {
      if (!transactions.has(tx)) {
        transactions.add(tx)
        transactionCallbacks++
      }
    },
    nativeTransaction(tx: object) {
      if (!nativeTransactions.has(tx)) {
        nativeTransactions.add(tx)
        nativeTransactionCallbacks++
      }
    },
    [Symbol.dispose]() {
      clearInterval(interval)
      emit()
    },
  }
}
