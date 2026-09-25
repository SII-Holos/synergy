import { installedWorkerCommand } from "@ericsanchezok/synergy-util/installed-launcher"
import { RuntimeContext } from "../lifecycle/context"
import fs from "fs"
import { fileURLToPath } from "url"
import { TelemetryProtocol } from "./telemetry-protocol"

const runnerPath = fileURLToPath(new URL("./telemetry-worker.ts", import.meta.url))

export namespace ObservabilityTelemetryClient {
  const MAX_PENDING = 10_000
  const FLUSH_DELAY_MS = 250
  const RESTART_BACKOFF_BASE_MS = 250
  const RESTART_BACKOFF_MAX_MS = 30_000

  const runtimeState = RuntimeContext.state(() => ({
    started: false,
    worker: undefined as Bun.Subprocess | undefined,
    workerReady: false,
    stopping: undefined as Promise<void> | undefined,
    restarts: 0,
    failures: 0,
    restartTimer: undefined as ReturnType<typeof setTimeout> | undefined,
    flushTimer: undefined as ReturnType<typeof setTimeout> | undefined,
    nextAckId: 0,
    dropped: 0,
    lastError: undefined as string | undefined,
    currentInput: undefined as { dbPath: string; config: TelemetryProtocol.WorkerConfig } | undefined,
    pending: [] as TelemetryProtocol.BatchRow[],
    sentBatches: [] as number[],
    ackWaiters: new Map<number, () => void>(),
    bufferedControls: [] as Array<() => void>,
    lastWorkerCommitted: 0,
    lastWorkerDropped: 0,
    statusMirror: {
      capExceededBytes: 0,
      maintenanceDeferred: false,
      lastFlushDurationMs: 0,
    },
  }))

  export function start(input: { dbPath: string; config: TelemetryProtocol.WorkerConfig }): void {
    const instanceState = runtimeState()

    if (instanceState.stopping) throw new Error("Telemetry worker is stopping")
    if (instanceState.started) return
    instanceState.started = true
    // Fresh client lifecycles reset the counters so tests and long-running
    // re-enables observe restart behavior from a clean baseline.
    instanceState.restarts = 0
    instanceState.failures = 0
    instanceState.currentInput = input
    spawnWorker(input)
  }

  export function enqueue(row: TelemetryProtocol.BatchRow): void {
    const instanceState = runtimeState()

    if (!instanceState.started) return
    instanceState.pending.push(row)
    if (instanceState.pending.length >= MAX_PENDING) {
      const dropCount = Math.max(1, Math.floor(MAX_PENDING / 10))
      instanceState.pending.splice(0, dropCount)
      instanceState.dropped += dropCount
    }
    if (!instanceState.flushTimer) {
      instanceState.flushTimer = setTimeout(flushPending, FLUSH_DELAY_MS)
      instanceState.flushTimer.unref()
    }
  }

  export function flushPending(): void {
    const instanceState = runtimeState()

    if (instanceState.flushTimer) {
      clearTimeout(instanceState.flushTimer)
      instanceState.flushTimer = undefined
    }
    if (!instanceState.workerReady || !instanceState.started) return
    while (instanceState.pending.length) {
      const chunk: TelemetryProtocol.BatchRow[] = []
      let chunkBytes = 0
      while (instanceState.pending.length && chunk.length < TelemetryProtocol.BATCH_CHUNK_ROWS) {
        const rowBytes = TelemetryProtocol.estimateRowBytes(instanceState.pending[0])
        if (chunk.length > 0 && chunkBytes + rowBytes > TelemetryProtocol.BATCH_MAX_BYTES) break
        chunk.push(instanceState.pending.shift()!)
        chunkBytes += rowBytes
      }
      instanceState.sentBatches.push(chunk.length)
      send({ type: "batch", rows: chunk })
    }
  }

  export async function flushAndWait(timeoutMs = 5000): Promise<void> {
    const instanceState = runtimeState()

    flushPending()
    if (!instanceState.pending.length && !instanceState.workerReady) return
    const deadline = Date.now() + timeoutMs
    while (instanceState.pending.length && !instanceState.workerReady && Date.now() < deadline) {
      await Bun.sleep(25)
    }
    flushPending()
    if (!instanceState.workerReady) {
      killWorker()
      return
    }
    const ackId = instanceState.nextAckId++
    send({ type: "flush", ackId })
    await new Promise<void>((resolve) => {
      const timer = setTimeout(
        () => {
          instanceState.ackWaiters.delete(ackId)
          killWorker()
          resolve()
        },
        Math.max(0, deadline - Date.now()),
      )
      instanceState.ackWaiters.set(ackId, () => {
        clearTimeout(timer)
        resolve()
      })
    })
  }

  export function sendInterruptSpans(reason: "previous_runtime_ended" | "runtime_shutdown"): void {
    enqueueControl({ type: "interrupt-spans", reason })
  }

  export function sendRetainNow(): void {
    enqueueControl({ type: "retain-now" })
  }

  export function sendCheckpoint(): void {
    enqueueControl({ type: "checkpoint" })
  }

  export function sendReconfigure(config: TelemetryProtocol.WorkerConfig): void {
    const instanceState = runtimeState()

    if (instanceState.currentInput) instanceState.currentInput = { ...instanceState.currentInput, config }
    enqueueControl({ type: "reconfigure", config })
  }

  export function stop(graceMs = 5000): Promise<void> {
    const state = runtimeState()
    return (state.stopping ??= stopWorker(graceMs).finally(() => {
      state.stopping = undefined
    }))
  }

  async function stopWorker(graceMs: number): Promise<void> {
    const instanceState = runtimeState()

    if (!instanceState.started) return
    if (instanceState.restartTimer) {
      clearTimeout(instanceState.restartTimer)
      instanceState.restartTimer = undefined
    }
    if (instanceState.flushTimer) {
      clearTimeout(instanceState.flushTimer)
      instanceState.flushTimer = undefined
    }
    instanceState.bufferedControls.length = 0
    // Drain while the client is still active; flushPending() checks `started`.
    flushPending()
    instanceState.started = false
    const active = instanceState.worker
    if (active && instanceState.workerReady) {
      try {
        active.send({ type: "shutdown" } satisfies TelemetryProtocol.HostToWorker)
      } catch {
        active.kill()
        await active.exited.catch(() => undefined)
        instanceState.worker = undefined
        instanceState.workerReady = false
        failAllWaiters()
      }
    }
    if (active) {
      let timeout: ReturnType<typeof setTimeout> | undefined
      const exited = await Promise.race([
        active.exited.then(() => true),
        new Promise<boolean>((resolve) => {
          timeout = setTimeout(() => resolve(false), graceMs)
        }),
      ]).finally(() => clearTimeout(timeout))
      if (!exited) {
        active.kill()
        await active.exited.catch(() => undefined)
      }
    }
    instanceState.dropped +=
      instanceState.pending.length + instanceState.sentBatches.reduce((total, rows) => total + rows, 0)
    instanceState.pending.length = 0
    instanceState.sentBatches.length = 0
    instanceState.lastWorkerCommitted = 0
    instanceState.lastWorkerDropped = 0
    if (instanceState.worker === active) {
      instanceState.worker = undefined
      instanceState.workerReady = false
      failAllWaiters()
    }
  }

  export function stats() {
    const instanceState = runtimeState()

    return {
      pending: instanceState.pending.length,
      unconfirmed: instanceState.sentBatches.reduce((total, rows) => total + rows, 0),
      dropped: instanceState.dropped,
      workerReady: instanceState.workerReady,
      restarts: instanceState.restarts,
      lastError: instanceState.lastError,
      capExceededBytes: instanceState.statusMirror.capExceededBytes,
      maintenanceDeferred: instanceState.statusMirror.maintenanceDeferred,
      lastFlushDurationMs: instanceState.statusMirror.lastFlushDurationMs,
    }
  }

  export function active(): boolean {
    const instanceState = runtimeState()

    return instanceState.started && RuntimeContext.current().host.env.SYNERGY_OBSERVABILITY_INLINE !== "1"
  }

  export function workerProcess(): Bun.Subprocess | undefined {
    const instanceState = runtimeState()

    return instanceState.worker
  }

  function spawnWorker(input: { dbPath: string; config: TelemetryProtocol.WorkerConfig }): void {
    const instanceState = runtimeState()

    const command =
      installedWorkerCommand(RuntimeContext.current().host.env, "__observability-worker-runner") ??
      (fs.existsSync(runnerPath)
        ? [process.execPath, "run", runnerPath]
        : [process.execPath, "__observability-worker-runner"])
    const env: Record<string, string | undefined> = {
      ...RuntimeContext.current().host.env,
      SYNERGY_OBSERVABILITY_PARENT_PID: String(process.pid),
      SYNERGY_OBSERVABILITY_WORKER: "1",
    }
    delete env.SYNERGY_AGENT_WORKER
    delete env.SYNERGY_POLICY_WORKER
    const processHandle = Bun.spawn({
      cmd: command,
      env,
      ipc: RuntimeContext.current().bind((message: unknown) => {
        let parsed: TelemetryProtocol.WorkerToHost | undefined
        try {
          parsed = TelemetryProtocol.parseWorkerToHost(typeof message === "string" ? JSON.parse(message) : message)
        } catch {
          return
        }
        if (!parsed) return
        onMessage(parsed)
      }),
      stdout: "ignore",
      stderr: "ignore",
      onExit: RuntimeContext.current().bind(() => {
        if (instanceState.worker !== processHandle) return
        instanceState.worker = undefined
        instanceState.workerReady = false
        // Batches that left the queue but were never confirmed by this
        // worker are lost: count them as dropped so diagnostics stay honest.
        instanceState.dropped += instanceState.sentBatches.reduce((total, rows) => total + rows, 0)
        instanceState.sentBatches.length = 0
        instanceState.lastWorkerCommitted = 0
        instanceState.lastWorkerDropped = 0
        failAllWaiters()
        if (!instanceState.started) return
        instanceState.restarts++
        instanceState.failures++
        scheduleRestart()
      }),
    })
    instanceState.worker = processHandle
    // Bun buffers IPC messages until the child registers its handler, so the
    // start message can be sent immediately; the worker replies with ready
    // once the database is open.
    processHandle.send({ type: "start", dbPath: input.dbPath, config: input.config })
  }

  function onMessage(message: TelemetryProtocol.WorkerToHost): void {
    const instanceState = runtimeState()

    switch (message.type) {
      case "ready":
        if (!instanceState.started) {
          instanceState.worker?.send({ type: "shutdown" } satisfies TelemetryProtocol.HostToWorker)
          break
        }
        instanceState.workerReady = true
        instanceState.failures = 0
        instanceState.lastWorkerCommitted = 0
        instanceState.lastWorkerDropped = 0
        flushPending()
        for (const control of instanceState.bufferedControls.splice(0)) control()
        break
      case "ack": {
        const waiter = instanceState.ackWaiters.get(message.ackId)
        instanceState.ackWaiters.delete(message.ackId)
        waiter?.()
        break
      }
      case "status":
        instanceState.statusMirror.capExceededBytes = message.counters.capExceededBytes
        instanceState.statusMirror.maintenanceDeferred = message.counters.maintenanceDeferred
        instanceState.statusMirror.lastFlushDurationMs = message.counters.lastFlushDurationMs
        if (message.counters.lastError) instanceState.lastError = message.counters.lastError
        confirmSentRows(
          message.counters.committed -
            instanceState.lastWorkerCommitted +
            (message.counters.dropped - instanceState.lastWorkerDropped),
        )
        instanceState.lastWorkerCommitted = message.counters.committed
        instanceState.lastWorkerDropped = message.counters.dropped
        break
    }
  }

  // Release sent-but-unconfirmed batches as the worker's cumulative
  // committed/dropped counters advance. Batches are processed in send order,
  // so the queue head always matches the next unconfirmed batch.
  function confirmSentRows(confirmed: number): void {
    const instanceState = runtimeState()

    let remaining = confirmed
    while (remaining > 0 && instanceState.sentBatches.length) {
      const head = instanceState.sentBatches[0]
      if (head <= remaining) {
        instanceState.sentBatches.shift()
        remaining -= head
      } else {
        instanceState.sentBatches[0] = head - remaining
        remaining = 0
      }
    }
  }

  function enqueueControl(message: TelemetryProtocol.HostToWorker): void {
    const instanceState = runtimeState()

    if (instanceState.workerReady) {
      send(message)
      return
    }
    instanceState.bufferedControls.push(() => send(message))
  }

  function send(message: TelemetryProtocol.HostToWorker): void {
    const instanceState = runtimeState()

    instanceState.worker?.send(message)
  }

  function failAllWaiters(): void {
    const instanceState = runtimeState()

    for (const waiter of instanceState.ackWaiters.values()) waiter()
    instanceState.ackWaiters.clear()
  }

  function scheduleRestart(): void {
    const instanceState = runtimeState()

    if (instanceState.restartTimer) return
    const delay = Math.min(RESTART_BACKOFF_MAX_MS, RESTART_BACKOFF_BASE_MS * 2 ** instanceState.failures)
    instanceState.restartTimer = setTimeout(() => {
      instanceState.restartTimer = undefined
      if (instanceState.currentInput) spawnWorker(instanceState.currentInput)
    }, delay)
    instanceState.restartTimer.unref()
  }

  function killWorker(): void {
    const instanceState = runtimeState()

    const active = instanceState.worker
    if (!active) return
    try {
      active.kill(9)
    } catch {}
  }
}
