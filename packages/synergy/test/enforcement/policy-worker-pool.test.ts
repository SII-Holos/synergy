import { describe, expect, test } from "bun:test"
import type { PolicyWorkerProcess, SpawnPolicyWorkerProcessOptions } from "@/enforcement/policy-worker/process-host"
import { PolicyWorkerProtocol } from "@/enforcement/policy-worker/protocol"
import {
  DEFAULT_POLICY_WORKER_POOL_OPTIONS,
  PolicyWorkerPool,
  PolicyWorkerStartupTimeoutError,
  PolicyWorkerTimeoutError,
} from "@/enforcement/policy-worker/worker-pool"

function classificationInput() {
  return {
    context: {
      activeWorkspace: "/tmp/project",
      workspaceType: "worktree",
      registeredMcpTools: [],
      registeredPluginTools: [],
      pluginToolCapabilities: {},
    },
    toolName: "bash",
    args: { command: "ls |& cat" },
  }
}

function policyMemory(rssBytes = 1024, heapUsedBytes = 512): PolicyWorkerProtocol.WorkerMemory {
  return {
    rssBytes,
    heapUsedBytes,
    heapTotalBytes: heapUsedBytes + 256,
    externalBytes: 128,
    arrayBuffersBytes: 64,
  }
}

function fakeProcess(
  options: SpawnPolicyWorkerProcessOptions,
  behavior: "unready" | "hang" | "error" | "result" | "result-no-release",
  state: { killed: boolean },
): PolicyWorkerProcess {
  let exited = false
  let requests = 0
  const subprocess = {
    exitCode: null,
    kill() {
      if (exited) return
      exited = true
      state.killed = true
      options.onExit(null, "SIGTERM")
    },
  } as unknown as Bun.Subprocess

  if (behavior !== "unready") {
    queueMicrotask(() => {
      options.onMessage({
        type: "ready",
        protocolVersion: PolicyWorkerProtocol.VERSION,
        pid: behavior === "hang" ? 101 : 102,
        memory: policyMemory(),
      })
    })
  }

  return {
    process: subprocess,
    send(message) {
      if (message.type === "run-start") {
        queueMicrotask(() => options.onMessage({ type: "run-ready", requestId: message.requestId }))
        return
      }
      if (message.type === "run-chunk") {
        queueMicrotask(() =>
          options.onMessage({
            type: "chunk-ack",
            requestId: message.requestId,
            index: message.index,
          }),
        )
        return
      }
      if (message.type === "run-commit" && (behavior === "result" || behavior === "result-no-release")) {
        queueMicrotask(() => {
          const requestId = message.requestId
          options.onMessage({
            type: "result",
            requestId,
            result: { capabilities: [{ class: "shell_read", nonBypassable: false }] },
            requests: ++requests,
            memoryBeforeRelease: policyMemory(),
            memoryAfterRelease: policyMemory(),
          })
          if (behavior === "result") {
            queueMicrotask(() =>
              options.onMessage({
                type: "released",
                requestId,
                requests,
                memory: policyMemory(),
              }),
            )
          }
        })
      }
      if (message.type === "run-commit" && behavior === "error") {
        queueMicrotask(() =>
          options.onMessage({
            type: "error",
            requestId: message.requestId,
            error: { name: "ClassifierError", message: "classification failed" },
          }),
        )
      }
    },
    async stop() {
      subprocess.kill()
    },
  }
}

describe("PolicyWorkerPool", () => {
  test("does not reuse a worker until the released memory sample arrives", async () => {
    let workerOptions: SpawnPolicyWorkerProcessOptions | undefined
    const sent: PolicyWorkerProtocol.HostToWorker[] = []
    const pool = new PolicyWorkerPool(
      {
        ...DEFAULT_POLICY_WORKER_POOL_OPTIONS,
        size: 1,
        timeoutMs: 500,
        heartbeatTimeoutMs: 10_000,
      },
      (options) => {
        workerOptions = options
        queueMicrotask(() =>
          options.onMessage({
            type: "ready",
            protocolVersion: PolicyWorkerProtocol.VERSION,
            pid: 101,
            memory: {
              rssBytes: 100,
              heapUsedBytes: 40,
              heapTotalBytes: 80,
              externalBytes: 20,
              arrayBuffersBytes: 10,
            },
          }),
        )
        return {
          process: { exitCode: null, kill() {} } as unknown as Bun.Subprocess,
          send(message) {
            sent.push(message)
            if (message.type === "run-start") {
              queueMicrotask(() => options.onMessage({ type: "run-ready", requestId: message.requestId }))
            } else if (message.type === "run-chunk") {
              queueMicrotask(() =>
                options.onMessage({ type: "chunk-ack", requestId: message.requestId, index: message.index }),
              )
            } else if (message.type === "run-commit") {
              queueMicrotask(() =>
                options.onMessage({
                  type: "result",
                  requestId: message.requestId,
                  result: { capabilities: [{ class: "shell_read", nonBypassable: false }] },
                  requests: 1,
                  memoryBeforeRelease: {
                    rssBytes: 140,
                    heapUsedBytes: 50,
                    heapTotalBytes: 90,
                    externalBytes: 30,
                    arrayBuffersBytes: 12,
                  },
                  memoryAfterRelease: {
                    rssBytes: 130,
                    heapUsedBytes: 45,
                    heapTotalBytes: 90,
                    externalBytes: 25,
                    arrayBuffersBytes: 11,
                  },
                }),
              )
            }
          },
          async stop() {},
        }
      },
    )

    try {
      const first = pool.run(classificationInput())
      const second = pool.run(classificationInput())
      await expect(first).resolves.toMatchObject({ capabilities: [{ class: "shell_read" }] })
      expect(sent.filter((message) => message.type === "run-start")).toHaveLength(1)

      const firstStart = sent.find(
        (message): message is Extract<PolicyWorkerProtocol.HostToWorker, { type: "run-start" }> =>
          message.type === "run-start",
      )!
      workerOptions?.onMessage({
        type: "released",
        requestId: firstStart.requestId,
        requests: 1,
        memory: {
          rssBytes: 110,
          heapUsedBytes: 42,
          heapTotalBytes: 90,
          externalBytes: 21,
          arrayBuffersBytes: 10,
        },
      })
      for (let i = 0; i < 20 && sent.filter((message) => message.type === "run-start").length < 2; i++) {
        await Bun.sleep(1)
      }
      expect(sent.filter((message) => message.type === "run-start")).toHaveLength(2)
      pool.stop()
      await second.catch(() => undefined)
    } finally {
      await pool.stop()
    }
  })

  test("bounds a worker that returns a result without releasing its request", async () => {
    const states: Array<{ killed: boolean }> = []
    const pool = new PolicyWorkerPool(
      {
        ...DEFAULT_POLICY_WORKER_POOL_OPTIONS,
        size: 1,
        timeoutMs: 10,
        heartbeatTimeoutMs: 10_000,
      },
      (options) => {
        const state = { killed: false }
        states.push(state)
        return fakeProcess(options, "result-no-release", state)
      },
    )

    try {
      await expect(pool.run(classificationInput())).resolves.toMatchObject({
        capabilities: [{ class: "shell_read" }],
      })
      for (let i = 0; i < 40 && !states[0]?.killed; i++) await Bun.sleep(1)
      expect(states[0]?.killed).toBe(true)
    } finally {
      await pool.stop()
    }
  })

  test("waits for a worker handshake before reporting the pool ready", async () => {
    let workerOptions: SpawnPolicyWorkerProcessOptions | undefined
    const pool = new PolicyWorkerPool(
      {
        ...DEFAULT_POLICY_WORKER_POOL_OPTIONS,
        size: 1,
        heartbeatTimeoutMs: 100,
      },
      (options) => {
        workerOptions = options
        return fakeProcess(options, "unready", { killed: false })
      },
    )

    try {
      pool.start()
      const ready = pool.ready()
      let settled = false
      void ready.finally(() => {
        settled = true
      })

      await Bun.sleep(1)
      expect(settled).toBe(false)

      workerOptions?.onMessage({
        type: "ready",
        protocolVersion: PolicyWorkerProtocol.VERSION,
        pid: 100,
        memory: policyMemory(),
      })

      await expect(ready).resolves.toBeUndefined()
      expect(pool.stats().ready).toBe(1)
    } finally {
      await pool.stop()
    }
  })

  test("bounds readiness when a worker process never completes its handshake", async () => {
    const pool = new PolicyWorkerPool(
      {
        ...DEFAULT_POLICY_WORKER_POOL_OPTIONS,
        size: 1,
        heartbeatTimeoutMs: 10_000,
      },
      (options) => fakeProcess(options, "unready", { killed: false }),
      {
        startupReadyTimeoutMs: 5,
      },
    )

    try {
      await expect(pool.ready()).rejects.toBeInstanceOf(PolicyWorkerStartupTimeoutError)
    } finally {
      await pool.stop()
    }
  })

  test("stays ready while all workers are busy so later requests can enter the bounded queue", async () => {
    const pool = new PolicyWorkerPool(
      {
        ...DEFAULT_POLICY_WORKER_POOL_OPTIONS,
        size: 1,
        timeoutMs: 500,
        heartbeatTimeoutMs: 10_000,
      },
      (options) => fakeProcess(options, "hang", { killed: false }),
    )
    const controller = new AbortController()

    try {
      const active = pool.run(classificationInput(), controller.signal)
      for (let i = 0; i < 20 && pool.stats().active === 0; i++) await Bun.sleep(1)

      expect(pool.stats().active).toBe(1)
      await expect(pool.ready()).resolves.toBeUndefined()

      controller.abort()
      await expect(active).rejects.toMatchObject({ name: "AbortError" })
    } finally {
      await pool.stop()
    }
  })

  test("backs off repeated startup exits and opens a finite startup circuit", async () => {
    let spawned = 0
    const pool = new PolicyWorkerPool(
      {
        ...DEFAULT_POLICY_WORKER_POOL_OPTIONS,
        size: 1,
        timeoutMs: 100,
        heartbeatTimeoutMs: 10_000,
      },
      (options) => {
        spawned++
        const host = fakeProcess(options, "unready", { killed: false })
        queueMicrotask(() => options.onExit(1, null))
        return host
      },
      {
        startupBackoffBaseMs: 0,
        startupBackoffMaxMs: 0,
        maxConsecutiveStartupFailures: 2,
        sleep: async () => {},
      },
    )

    try {
      pool.start()
      for (let i = 0; i < 20 && spawned < 3; i++) await Bun.sleep(1)

      expect(spawned).toBe(3)
      await expect(pool.run(classificationInput())).rejects.toThrow(
        "Policy worker failed to start after 3 consecutive attempts",
      )
      await Bun.sleep(1)
      expect(spawned).toBe(3)
    } finally {
      await pool.stop()
    }
  })

  test("rejects queue overflow and replaces only the worker owned by an aborted request", async () => {
    const states = [{ killed: false }, { killed: false }]
    let spawned = 0
    const pool = new PolicyWorkerPool(
      {
        ...DEFAULT_POLICY_WORKER_POOL_OPTIONS,
        size: 1,
        maxQueued: 0,
        timeoutMs: 500,
        heartbeatTimeoutMs: 10_000,
      },
      (options) => fakeProcess(options, spawned++ === 0 ? "hang" : "result", states[spawned - 1]),
    )
    const controller = new AbortController()

    try {
      const active = pool.run(classificationInput(), controller.signal)
      for (let i = 0; i < 20 && pool.stats().active === 0; i++) await Bun.sleep(1)

      expect(pool.stats().active).toBe(1)
      await expect(pool.run(classificationInput())).rejects.toThrow("Policy worker queue is full")
      expect(states[0].killed).toBe(false)

      controller.abort()
      await expect(active).rejects.toMatchObject({ name: "AbortError" })
      expect(states[0].killed).toBe(true)
      await expect(pool.run(classificationInput())).resolves.toMatchObject({
        capabilities: [{ class: "shell_read" }],
      })
    } finally {
      await pool.stop()
    }
  })

  test("kills a timed-out worker and replaces it for the next classification", async () => {
    const states = [{ killed: false }, { killed: false }]
    let spawned = 0
    const pool = new PolicyWorkerPool(
      {
        ...DEFAULT_POLICY_WORKER_POOL_OPTIONS,
        size: 1,
        timeoutMs: 50,
        heartbeatTimeoutMs: 10_000,
      },
      (options) => fakeProcess(options, spawned++ === 0 ? "hang" : "result", states[spawned - 1]),
    )

    try {
      await expect(pool.run(classificationInput())).rejects.toBeInstanceOf(PolicyWorkerTimeoutError)
      expect(states[0].killed).toBe(true)
      await expect(pool.run(classificationInput())).resolves.toEqual({
        capabilities: [{ class: "shell_read", nonBypassable: false }],
      })
      expect(spawned).toBe(2)
    } finally {
      await pool.stop()
    }
  })

  test("replaces a worker that never becomes ready when its queued request expires", async () => {
    const states = [{ killed: false }, { killed: false }]
    let spawned = 0
    const pool = new PolicyWorkerPool(
      {
        ...DEFAULT_POLICY_WORKER_POOL_OPTIONS,
        size: 1,
        timeoutMs: 50,
        heartbeatTimeoutMs: 10_000,
      },
      (options) => fakeProcess(options, spawned++ === 0 ? "unready" : "result", states[spawned - 1]),
    )

    try {
      await expect(pool.run(classificationInput())).rejects.toBeInstanceOf(PolicyWorkerTimeoutError)
      expect(states[0].killed).toBe(true)
      await expect(pool.run(classificationInput())).resolves.toMatchObject({
        capabilities: [{ class: "shell_read" }],
      })
    } finally {
      await pool.stop()
    }
  })

  test("recycles a worker after a classifier exception", async () => {
    const states = [{ killed: false }, { killed: false }]
    let spawned = 0
    const pool = new PolicyWorkerPool(
      {
        ...DEFAULT_POLICY_WORKER_POOL_OPTIONS,
        size: 1,
        timeoutMs: 100,
        heartbeatTimeoutMs: 10_000,
      },
      (options) => fakeProcess(options, spawned++ === 0 ? "error" : "result", states[spawned - 1]),
    )

    try {
      await expect(pool.run(classificationInput())).rejects.toMatchObject({
        name: "ClassifierError",
        message: "classification failed",
      })
      expect(states[0].killed).toBe(true)
      await expect(pool.run(classificationInput())).resolves.toMatchObject({
        capabilities: [{ class: "shell_read" }],
      })
    } finally {
      await pool.stop()
    }
  })

  test("recycles a healthy worker after its configured request budget", async () => {
    const states = [{ killed: false }, { killed: false }]
    let spawned = 0
    const pool = new PolicyWorkerPool(
      {
        ...DEFAULT_POLICY_WORKER_POOL_OPTIONS,
        size: 1,
        maxRequests: 2,
        timeoutMs: 100,
        heartbeatTimeoutMs: 10_000,
      },
      (options) => fakeProcess(options, "result", states[spawned++]),
    )

    try {
      await expect(pool.run(classificationInput())).resolves.toMatchObject({
        capabilities: [{ class: "shell_read" }],
      })
      expect(states[0].killed).toBe(false)
      await expect(pool.run(classificationInput())).resolves.toMatchObject({
        capabilities: [{ class: "shell_read" }],
      })
      expect(states[0].killed).toBe(true)
      await expect(pool.run(classificationInput())).resolves.toMatchObject({
        capabilities: [{ class: "shell_read" }],
      })
      expect(spawned).toBe(2)
    } finally {
      await pool.stop()
    }
  })
})
