import fs from "fs"
import { fileURLToPath } from "url"
import { TelemetryProtocol } from "./telemetry-protocol"

const runnerPath = fileURLToPath(new URL("./telemetry-worker.ts", import.meta.url))

export namespace ObservabilityTelemetryClient {
  const MAX_PENDING = 10_000
  const FLUSH_DELAY_MS = 250
  const RESTART_BACKOFF_BASE_MS = 250
  const RESTART_BACKOFF_MAX_MS = 30_000

  let started = false
  let worker: Bun.Subprocess | undefined
  let workerReady = false
  let restarts = 0
  let failures = 0
  let restartTimer: ReturnType<typeof setTimeout> | undefined
  let flushTimer: ReturnType<typeof setTimeout> | undefined
  let nextAckId = 0
  let dropped = 0
  let lastError: string | undefined
  const pending: TelemetryProtocol.BatchRow[] = []
  const ackWaiters = new Map<number, () => void>()
  const bufferedControls: Array<() => void> = []
  const statusMirror = {
    capExceededBytes: 0,
    maintenanceDeferred: false,
    lastFlushDurationMs: 0,
  }

  export function start(input: { dbPath: string; config: TelemetryProtocol.WorkerConfig }): void {
    if (started) return
    started = true
    spawnWorker(input)
  }

  export function enqueue(row: TelemetryProtocol.BatchRow): void {
    pending.push(row)
    if (pending.length >= MAX_PENDING) {
      const dropCount = Math.max(1, Math.floor(MAX_PENDING / 10))
      pending.splice(0, dropCount)
      dropped += dropCount
    }
    if (!flushTimer) {
      flushTimer = setTimeout(flushPending, FLUSH_DELAY_MS)
      flushTimer.unref()
    }
  }

  export function flushPending(): void {
    if (flushTimer) {
      clearTimeout(flushTimer)
      flushTimer = undefined
    }
    if (!workerReady || !started) return
    while (pending.length) {
      const chunk = pending.splice(0, TelemetryProtocol.BATCH_CHUNK_ROWS)
      send({ type: "batch", rows: chunk })
    }
  }

  export async function flushAndWait(timeoutMs = 5000): Promise<void> {
    flushPending()
    if (!pending.length && !workerReady) return
    const deadline = Date.now() + timeoutMs
    while (pending.length && !workerReady && Date.now() < deadline) {
      await Bun.sleep(25)
    }
    flushPending()
    if (!workerReady) {
      killWorker()
      return
    }
    const ackId = nextAckId++
    send({ type: "flush", ackId })
    await new Promise<void>((resolve) => {
      const timer = setTimeout(
        () => {
          ackWaiters.delete(ackId)
          killWorker()
          resolve()
        },
        Math.max(0, deadline - Date.now()),
      )
      ackWaiters.set(ackId, () => {
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
    enqueueControl({ type: "reconfigure", config })
  }

  export async function stop(graceMs = 5000): Promise<void> {
    if (!started) return
    started = false
    if (restartTimer) {
      clearTimeout(restartTimer)
      restartTimer = undefined
    }
    bufferedControls.length = 0
    const active = worker
    if (!active) {
      workerReady = false
      return
    }
    try {
      active.send({ type: "shutdown" } satisfies TelemetryProtocol.HostToWorker)
    } catch {
      active.kill()
      await active.exited.catch(() => undefined)
      worker = undefined
      workerReady = false
      failAllWaiters()
      return
    }
    const exited = await Promise.race([
      active.exited.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), graceMs)),
    ])
    if (!exited) {
      active.kill()
      await active.exited.catch(() => undefined)
    }
    if (worker === active) {
      worker = undefined
      workerReady = false
      failAllWaiters()
    }
  }

  export function stats() {
    return {
      pending: pending.length,
      dropped,
      workerReady,
      restarts,
      lastError,
      capExceededBytes: statusMirror.capExceededBytes,
      maintenanceDeferred: statusMirror.maintenanceDeferred,
      lastFlushDurationMs: statusMirror.lastFlushDurationMs,
    }
  }

  export function active(): boolean {
    return started && process.env.SYNERGY_OBSERVABILITY_INLINE !== "1"
  }

  export function workerProcess(): Bun.Subprocess | undefined {
    return worker
  }

  function spawnWorker(input: { dbPath: string; config: TelemetryProtocol.WorkerConfig }): void {
    const command = fs.existsSync(runnerPath)
      ? [process.execPath, "run", runnerPath]
      : [process.execPath, "__observability-worker-runner"]
    const env: Record<string, string | undefined> = {
      ...process.env,
      SYNERGY_OBSERVABILITY_PARENT_PID: String(process.pid),
      SYNERGY_OBSERVABILITY_WORKER: "1",
    }
    delete env.SYNERGY_AGENT_WORKER
    delete env.SYNERGY_POLICY_WORKER
    const processHandle = Bun.spawn({
      cmd: command,
      env,
      ipc(message: unknown) {
        let parsed: TelemetryProtocol.WorkerToHost | undefined
        try {
          parsed = TelemetryProtocol.parseWorkerToHost(typeof message === "string" ? JSON.parse(message) : message)
        } catch {
          return
        }
        if (!parsed) return
        onMessage(parsed)
      },
      stdout: "ignore",
      stderr: "ignore",
      onExit: () => {
        if (worker !== processHandle) return
        worker = undefined
        workerReady = false
        failAllWaiters()
        if (!started) return
        restarts++
        failures++
        scheduleRestart(input)
      },
    })
    worker = processHandle
    // Bun buffers IPC messages until the child registers its handler, so the
    // start message can be sent immediately; the worker replies with ready
    // once the database is open.
    processHandle.send({ type: "start", dbPath: input.dbPath, config: input.config })
  }

  function onMessage(message: TelemetryProtocol.WorkerToHost): void {
    switch (message.type) {
      case "ready":
        workerReady = true
        failures = 0
        flushPending()
        for (const control of bufferedControls.splice(0)) control()
        break
      case "ack": {
        const waiter = ackWaiters.get(message.ackId)
        ackWaiters.delete(message.ackId)
        waiter?.()
        break
      }
      case "status":
        statusMirror.capExceededBytes = message.counters.capExceededBytes
        statusMirror.maintenanceDeferred = message.counters.maintenanceDeferred
        statusMirror.lastFlushDurationMs = message.counters.lastFlushDurationMs
        if (message.counters.lastError) lastError = message.counters.lastError
        break
    }
  }

  function enqueueControl(message: TelemetryProtocol.HostToWorker): void {
    if (workerReady) {
      send(message)
      return
    }
    bufferedControls.push(() => send(message))
  }

  function send(message: TelemetryProtocol.HostToWorker): void {
    worker?.send(message)
  }

  function failAllWaiters(): void {
    for (const waiter of ackWaiters.values()) waiter()
    ackWaiters.clear()
  }

  function scheduleRestart(input: { dbPath: string; config: TelemetryProtocol.WorkerConfig }): void {
    if (restartTimer) return
    const delay = Math.min(RESTART_BACKOFF_MAX_MS, RESTART_BACKOFF_BASE_MS * 2 ** failures)
    restartTimer = setTimeout(() => {
      restartTimer = undefined
      spawnWorker(input)
    }, delay)
    restartTimer.unref()
  }

  function killWorker(): void {
    const active = worker
    if (!active) return
    try {
      active.kill(9)
    } catch {}
  }
}
