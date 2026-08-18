import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { SynergyLinkInboundHandler } from "../src/inbound/handler"
import { RPCHandler } from "../src/rpc/handler"
import { SessionManager } from "../src/session/manager"

const callerA = { type: "holos", agentID: "agent_a", ownerUserID: 1 }
const callerB = { type: "holos", agentID: "agent_b", ownerUserID: 2 }

function createHost(input?: {
  onChange?: (state: {
    current: ReturnType<SessionManager["current"]>
    blockedAgentIDs: string[]
  }) => void | Promise<void>
}) {
  const rpc = new RPCHandler({ linkID: "link_test" })
  let inbound!: SynergyLinkInboundHandler
  const sessions = new SessionManager({
    onChange: input?.onChange,
    onEnd: async (session) => {
      await rpc.processRegistry.releaseSession(session)
      inbound.clearSessionRequests(session.sessionID)
    },
  })
  inbound = new SynergyLinkInboundHandler(rpc, sessions, async () => "approve")
  return { rpc, sessions, inbound }
}

async function openSession(host: ReturnType<typeof createHost>, caller = callerA) {
  const response = await host.inbound.handle({
    caller,
    body: {
      version: 2,
      requestID: crypto.randomUUID(),
      linkID: "link_test",
      tool: "session",
      action: "open",
      payload: { action: "open" },
    },
  })
  expect(response.ok).toBe(true)
  if (!response.ok || response.tool !== "session" || !response.result.metadata.sessionID) {
    throw new Error("Session did not open")
  }
  return response.result.metadata.sessionID
}

async function execute(
  host: ReturnType<typeof createHost>,
  sessionID: string,
  requestID: string,
  command: string,
  caller = callerA,
) {
  return await host.inbound.handle({
    caller,
    body: {
      version: 2,
      requestID,
      linkID: "link_test",
      tool: "bash",
      action: "execute",
      sessionID,
      payload: { command, description: "host hardening", background: true },
    },
  })
}

function processID(response: Awaited<ReturnType<typeof execute>>) {
  if (!response.ok || response.tool !== "bash") throw new Error("Bash request failed")
  const id = response.result.metadata.processId
  if (!id) throw new Error("Bash request did not return a process ID")
  return id
}

type ProcessAction = "poll" | "log" | "write" | "send-keys" | "kill" | "clear" | "remove"

async function processRequest(
  host: ReturnType<typeof createHost>,
  lease: { sessionID: string; callerAgentID: string; callerOwnerUserID: number },
  action: ProcessAction,
  processId: string,
  extra: Record<string, unknown> = {},
) {
  return await host.rpc.handle(
    {
      version: 2,
      requestID: crypto.randomUUID(),
      linkID: "link_test",
      tool: "process",
      action,
      sessionID: lease.sessionID,
      payload: { action, processId, ...extra },
    },
    lease,
  )
}

const leaseA = (sessionID: string) => ({
  sessionID,
  callerAgentID: callerA.agentID,
  callerOwnerUserID: callerA.ownerUserID,
})

const leaseB = (sessionID = "session_foreign") => ({
  sessionID,
  callerAgentID: callerB.agentID,
  callerOwnerUserID: callerB.ownerUserID,
})

describe("synergy-link host hardening", () => {
  test("scopes every process read and control action to the validated caller session", async () => {
    const host = createHost()
    try {
      const sessionA = await openSession(host)
      const started = await execute(host, sessionA, "req_owner", "sleep 30")
      const id = processID(started)
      const foreign = leaseB()

      const actions: Array<[ProcessAction, Record<string, unknown>]> = [
        ["poll", {}],
        ["log", {}],
        ["write", { data: "foreign input" }],
        ["send-keys", { keys: ["C-c"] }],
        ["kill", {}],
        ["clear", {}],
        ["remove", {}],
      ]
      for (const [action, extra] of actions) {
        const response = await processRequest(host, foreign, action, id, extra)
        expect(response.ok).toBe(false)
        if (!response.ok) {
          expect(response.error.code).toBe("process_not_found")
          expect(response.error.message).not.toContain("sleep 30")
        }
        expect(host.rpc.processRegistry.has(id)).toBe(true)
      }

      const foreignList = await host.rpc.handle(
        {
          version: 2,
          requestID: "req_list_foreign",
          linkID: "link_test",
          tool: "process",
          action: "list",
          sessionID: foreign.sessionID,
          payload: { action: "list" },
        },
        foreign,
      )
      expect(foreignList.ok).toBe(true)
      if (foreignList.ok && foreignList.tool === "process") {
        expect(foreignList.result.metadata.processes).toEqual([])
        expect(foreignList.result.output).not.toContain(id)
      }

      const ownerKill = await processRequest(host, leaseA(sessionA), "kill", id)
      expect(ownerKill.ok).toBe(true)
    } finally {
      await host.rpc.processRegistry.reset()
    }
  })

  test("does not expose finished process output to another lease", async () => {
    const host = createHost()
    try {
      const sessionA = await openSession(host)
      const started = await execute(host, sessionA, "req_finished_owner", "printf owner-only-output")
      const id = processID(started)

      let ownerPoll = await processRequest(host, leaseA(sessionA), "poll", id)
      for (
        let attempt = 0;
        attempt < 100 && ownerPoll.ok && ownerPoll.result.metadata.status === "running";
        attempt += 1
      ) {
        await Bun.sleep(10)
        ownerPoll = await processRequest(host, leaseA(sessionA), "poll", id)
      }
      expect(ownerPoll.ok).toBe(true)

      const foreignLog = await processRequest(host, leaseB(), "log", id)
      expect(foreignLog.ok).toBe(false)
      if (!foreignLog.ok) {
        expect(foreignLog.error.code).toBe("process_not_found")
        expect(foreignLog.error.message).not.toContain("owner-only-output")
      }
    } finally {
      await host.rpc.processRegistry.reset()
    }
  })

  test("session close terminates and removes its background process tree", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "synergy-link-session-cleanup-"))
    const readyPath = path.join(root, "ready")
    const stoppedPath = path.join(root, "stopped")
    const workerPath = path.join(root, "worker.ts")
    const host = createHost()
    try {
      await Bun.write(
        workerPath,
        `process.on("SIGTERM", async () => {\n  await Bun.write(${JSON.stringify(stoppedPath)}, "stopped")\n  process.exit(0)\n})\nawait Bun.write(${JSON.stringify(readyPath)}, "ready")\nsetInterval(() => {}, 1_000)\n`,
      )
      const sessionID = await openSession(host)
      const started = await execute(
        host,
        sessionID,
        "req_cleanup",
        `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(workerPath)}`,
      )
      const id = processID(started)
      for (let attempt = 0; attempt < 100 && !(await Bun.file(readyPath).exists()); attempt += 1) await Bun.sleep(10)
      expect(await Bun.file(readyPath).exists()).toBe(true)

      await host.sessions.close(callerA, sessionID)
      expect(await Bun.file(stoppedPath).exists()).toBe(true)
      expect(host.rpc.processRegistry.has(id)).toBe(false)
    } finally {
      await host.rpc.processRegistry.reset()
      await rm(root, { recursive: true, force: true })
    }
  })

  test.skipIf(process.platform === "win32")(
    "session close reaps a detached descendant after its nested shell exits",
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "synergy-link-detached-cleanup-"))
      const pidPath = path.join(root, "worker.pid")
      const readyPath = path.join(root, "ready")
      const stoppedPath = path.join(root, "stopped")
      const workerPath = path.join(root, "worker.ts")
      const launcherPath = path.join(root, "launcher.ts")
      const host = createHost()
      let workerPid: number | undefined
      try {
        await Bun.write(
          workerPath,
          `process.on("SIGTERM", async () => {\n  await Bun.write(${JSON.stringify(stoppedPath)}, "stopped")\n  process.exit(0)\n})\nawait Bun.write(${JSON.stringify(readyPath)}, "ready")\nsetInterval(() => {}, 1_000)\n`,
        )
        await Bun.write(
          launcherPath,
          `const child = Bun.spawn([process.execPath, ${JSON.stringify(workerPath)}], {\n  env: process.env,\n  stdin: "ignore",\n  stdout: "ignore",\n  stderr: "ignore",\n  detached: true,\n})\nchild.unref()\nawait Bun.write(${JSON.stringify(pidPath)}, String(child.pid))\nawait Bun.sleep(100)\n`,
        )
        const sessionID = await openSession(host)
        const nestedCommand = `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(launcherPath)}`
        const started = await execute(host, sessionID, "req_detached_cleanup", `sh -c ${JSON.stringify(nestedCommand)}`)
        const id = processID(started)
        await waitForCondition(async () => Bun.file(pidPath).exists())
        await waitForCondition(async () => Bun.file(readyPath).exists())
        workerPid = Number(await Bun.file(pidPath).text())
        expect(Number.isSafeInteger(workerPid)).toBe(true)
        expect(processIsAlive(workerPid)).toBe(true)

        await waitForCondition(async () => {
          const response = await processRequest(host, leaseA(sessionID), "poll", id)
          return !response.ok || response.tool !== "process" || response.result.metadata.status !== "running"
        })
        await host.sessions.close(callerA, sessionID)

        await waitForCondition(() => !processIsAlive(workerPid))
        expect(await Bun.file(stoppedPath).exists()).toBe(true)
        expect(host.rpc.processRegistry.has(id)).toBe(false)
      } finally {
        await host.rpc.processRegistry.reset()
        if (workerPid && processIsAlive(workerPid)) {
          try {
            process.kill(-workerPid, "SIGKILL")
          } catch {
            try {
              process.kill(workerPid, "SIGKILL")
            } catch {}
          }
        }
        await rm(root, { recursive: true, force: true })
      }
    },
    10_000,
  )

  test.skipIf(process.platform === "win32")(
    "clearing finished process history reaps its detached descendants",
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "synergy-link-detached-clear-"))
      const pidPath = path.join(root, "worker.pid")
      const workerPath = path.join(root, "worker.ts")
      const launcherPath = path.join(root, "launcher.ts")
      const host = createHost()
      let workerPid: number | undefined
      try {
        await Bun.write(workerPath, "setInterval(() => {}, 1_000)\n")
        await Bun.write(
          launcherPath,
          `const child = Bun.spawn([process.execPath, ${JSON.stringify(workerPath)}], {\n  env: process.env,\n  stdin: "ignore",\n  stdout: "ignore",\n  stderr: "ignore",\n  detached: true,\n})\nchild.unref()\nawait Bun.write(${JSON.stringify(pidPath)}, String(child.pid))\n`,
        )
        const sessionID = await openSession(host)
        const nestedCommand = `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(launcherPath)}`
        const started = await execute(host, sessionID, "req_detached_clear", `sh -c ${JSON.stringify(nestedCommand)}`)
        const id = processID(started)
        await waitForCondition(async () => Bun.file(pidPath).exists())
        workerPid = Number(await Bun.file(pidPath).text())
        await waitForCondition(() => processIsAlive(workerPid))
        await waitForCondition(async () => {
          const response = await processRequest(host, leaseA(sessionID), "poll", id)
          return response.ok && response.tool === "process" && response.result.metadata.status !== "running"
        })

        const cleared = await processRequest(host, leaseA(sessionID), "clear", id)

        expect(cleared.ok).toBe(true)
        if (cleared.ok && cleared.tool === "process") expect(cleared.result.metadata.status).toBe("cleared")
        await waitForCondition(() => !processIsAlive(workerPid))
        expect(host.rpc.processRegistry.has(id)).toBe(false)
      } finally {
        await host.rpc.processRegistry.reset()
        if (workerPid && processIsAlive(workerPid)) {
          try {
            process.kill(-workerPid, "SIGKILL")
          } catch {
            try {
              process.kill(workerPid, "SIGKILL")
            } catch {}
          }
        }
        await rm(root, { recursive: true, force: true })
      }
    },
    10_000,
  )

  test("session kick and idle expiry reap their background processes", async () => {
    for (const reason of ["kick", "expire"] as const) {
      const host = createHost()
      try {
        const sessionID = await openSession(host)
        const started = await execute(host, sessionID, `req_cleanup_${reason}`, "sleep 30")
        const id = processID(started)
        expect(host.rpc.processRegistry.has(id)).toBe(true)

        if (reason === "kick") await host.sessions.kickCurrent()
        else await host.sessions.expireIdle(Date.now() + 11 * 60_000)

        expect(host.rpc.processRegistry.has(id)).toBe(false)
      } finally {
        await host.rpc.processRegistry.reset()
      }
    }
  })

  test("returns a session_invalid envelope after the active session is kicked", async () => {
    const host = createHost()
    try {
      const sessionID = await openSession(host)
      await host.sessions.kickCurrent()

      const response = await host.inbound.handle({
        caller: callerA,
        body: {
          version: 2,
          requestID: "req_heartbeat_after_kick",
          linkID: "link_test",
          tool: "session",
          action: "heartbeat",
          payload: { action: "heartbeat", sessionID },
        },
      })

      expect(response.ok).toBe(false)
      if (!response.ok) {
        expect(response.requestID).toBe("req_heartbeat_after_kick")
        expect(response.tool).toBe("session")
        expect(response.action).toBe("heartbeat")
        expect(response.error.code).toBe("session_invalid")
      }
    } finally {
      await host.rpc.processRegistry.reset()
    }
  })

  test("does not launch a process after its session is revoked during validation", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "synergy-link-revoked-launch-"))
    const markerPath = path.join(root, "spawned")
    let blockNextChange = false
    let releaseValidation!: () => void
    const validationGate = new Promise<void>((resolve) => {
      releaseValidation = resolve
    })
    let validationStarted!: () => void
    const validationSignal = new Promise<void>((resolve) => {
      validationStarted = resolve
    })
    const host = createHost({
      onChange: async () => {
        if (!blockNextChange) return
        blockNextChange = false
        validationStarted()
        await validationGate
      },
    })
    try {
      const sessionID = await openSession(host)
      blockNextChange = true
      const pending = execute(
        host,
        sessionID,
        "req_revoked_launch",
        `printf spawned > ${JSON.stringify(markerPath)}; sleep 30`,
      )
      await validationSignal
      await host.sessions.close(callerA, sessionID)
      releaseValidation()

      const response = await pending
      expect(response.ok).toBe(false)
      if (!response.ok) expect(response.error.code).toBe("session_invalid")
      expect(await Bun.file(markerPath).exists()).toBe(false)
    } finally {
      releaseValidation()
      await host.rpc.processRegistry.reset()
      await rm(root, { recursive: true, force: true })
    }
  })

  test("blocks Windows detached launchers on Windows and allows them elsewhere", async () => {
    const host = createHost()
    try {
      const sessionID = await openSession(host)
      const commands = ['start "" /b long-running.exe', "Start-Process long-running.exe"]

      for (const [index, command] of commands.entries()) {
        const response = await execute(host, sessionID, `req_windows_detached_${index}`, command)
        if (process.platform === "win32") {
          expect(response.ok).toBe(false)
          if (!response.ok) {
            expect(response.error.code).toBe("invalid_request")
            expect(response.error.message).toContain("Blocked direct detached daemon launch pattern")
          }
        } else {
          expect(response.ok).toBe(true)
        }
      }
    } finally {
      await host.rpc.processRegistry.reset()
    }
  })

  test("allows marker-safe POSIX detached daemon launch patterns (session-owned cleanup still reaps them)", async () => {
    const host = createHost()
    try {
      const sessionID = await openSession(host)
      const commands = ["nohup sleep 0.1", "setsid sleep 0.1", "sleep 0.1 &", "sleep 0.1; disown"]

      for (const [index, command] of commands.entries()) {
        const response = await execute(host, sessionID, `req_posix_detached_${index}`, command)
        expect(response.ok).toBe(true)
      }
    } finally {
      await host.rpc.processRegistry.reset()
    }
  })

  test("detached processes survive session close (no owner marker, skipped by cleanup)", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "synergy-link-detach-"))
    const markerPath = path.join(root, "marker")
    const host = createHost()
    try {
      const sessionID = await openSession(host)
      const response = await host.inbound.handle({
        caller: callerA,
        body: {
          version: 2,
          requestID: "req_detach_survive",
          linkID: "link_test",
          tool: "bash",
          action: "execute",
          sessionID,
          payload: {
            command: `sleep 1 && touch ${JSON.stringify(markerPath)}`,
            description: "detach survival",
            background: true,
            detach: true,
          },
        },
      })
      expect(response.ok).toBe(true)

      await host.sessions.close(callerA, sessionID)
      await Bun.sleep(2_000)

      // The detached process must survive session close and finish its work.
      expect(await Bun.file(markerPath).exists()).toBe(true)
      expect(
        host.rpc.processRegistry.has(
          response.ok && response.tool === "bash" ? (response.result.metadata.processId ?? "") : "",
        ),
      ).toBe(false)
    } finally {
      await host.rpc.processRegistry.reset()
      await rm(root, { recursive: true, force: true })
    }
  }, 10_000)

  test("allows benign shell syntax that only mentions daemon tokens or ampersands", async () => {
    const host = createHost()
    try {
      const sessionID = await openSession(host)
      const commands = [
        `printf '%s' 'a & b'`,
        `printf '%s' 'nohup setsid disown daemonize tmux new-session -d screen -dm'`,
        "printf first && printf second",
        "printf redirected 2>&1",
        "printf redirected &> /dev/null",
        "printf redirected &>> /dev/null",
        "printf piped |& tee /dev/null",
        "sh -c 'printf wrapped'",
      ]

      for (const [index, command] of commands.entries()) {
        const response = await execute(host, sessionID, `req_benign_${index}`, command)
        expect(response.ok).toBe(true)
      }
    } finally {
      await host.rpc.processRegistry.reset()
    }
  })

  test("auto-backgrounds remote foreground execution without an explicit yield", async () => {
    const host = createHost()
    try {
      const sessionID = await openSession(host)
      const startedAt = Date.now()
      const response = await host.inbound.handle({
        caller: callerA,
        body: {
          version: 2,
          requestID: "req_default_yield_boundary",
          linkID: "link_test",
          tool: "bash",
          action: "execute",
          sessionID,
          payload: { command: "sleep 7", description: "default yield boundary" },
        },
      })

      expect(Date.now() - startedAt).toBeLessThan(6_500)
      expect(response.ok).toBe(true)
      if (response.ok && response.tool === "bash") {
        expect(response.result.metadata.background).toBe(true)
        expect(response.result.metadata.processId).toBeTruthy()
      }
    } finally {
      await host.rpc.processRegistry.reset()
    }
  }, 10_000)

  test("clamps zero-valued blocking poll timeouts", async () => {
    const host = createHost()
    try {
      const sessionID = await openSession(host)
      const started = await execute(host, sessionID, "req_poll_timeout", "sleep 2")
      const id = processID(started)
      const startedAt = Date.now()
      const response = await processRequest(host, leaseA(sessionID), "poll", id, { block: true, timeout: 0 })

      expect(Date.now() - startedAt).toBeLessThan(1_800)
      expect(response.ok).toBe(true)
      if (response.ok) expect(response.result.metadata.status).toBe("running")
    } finally {
      await host.rpc.processRegistry.reset()
    }
  })

  test("deduplicates concurrent retries by request ID within one session", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "synergy-link-request-dedup-"))
    const counterPath = path.join(root, "count")
    const host = createHost()
    try {
      const sessionID = await openSession(host)
      const command = `printf x >> ${JSON.stringify(counterPath)}; sleep 30`
      const [first, second] = await Promise.all([
        execute(host, sessionID, "req_duplicate", command),
        execute(host, sessionID, "req_duplicate", command),
      ])
      expect(processID(first)).toBe(processID(second))
      let counter: string | null = null
      for (let attempt = 0; attempt < 200 && counter !== "x"; attempt += 1) {
        counter = (await Bun.file(counterPath).exists()) ? await Bun.file(counterPath).text() : null
        if (counter !== "x") await Bun.sleep(10)
      }
      expect(counter).toBe("x")
    } finally {
      await host.rpc.processRegistry.reset()
      await rm(root, { recursive: true, force: true })
    }
  })

  test("rejects reuse of a request ID for a different command", async () => {
    const host = createHost()
    try {
      const sessionID = await openSession(host)
      const first = await execute(host, sessionID, "req_conflict", "sleep 30")
      const id = processID(first)
      const conflict = await execute(host, sessionID, "req_conflict", "printf must-not-run")

      expect(conflict.ok).toBe(false)
      if (!conflict.ok) {
        expect(conflict.error.code).toBe("invalid_request")
        expect(conflict.error.message).toContain("already used")
      }
      expect(host.rpc.processRegistry.has(id)).toBe(true)
    } finally {
      await host.rpc.processRegistry.reset()
    }
  })

  test("cleans up processes even when persisting the ended session fails", async () => {
    let failSessionEndSave = false
    const rpc = new RPCHandler({ linkID: "link_test" })
    const sessions = new SessionManager({
      onChange: async ({ current }) => {
        if (failSessionEndSave && !current) throw new Error("state save failed")
      },
      onEnd: async (session) => {
        await rpc.processRegistry.releaseSession(session)
      },
    })
    const inbound = new SynergyLinkInboundHandler(rpc, sessions, async () => "approve")
    const host = { rpc, sessions, inbound }
    try {
      const sessionID = await openSession(host)
      const started = await execute(host, sessionID, "req_cleanup_save_failure", "sleep 30")
      const id = processID(started)
      failSessionEndSave = true

      await expect(sessions.close(callerA, sessionID)).rejects.toThrow("state save failed")
      expect(rpc.processRegistry.has(id)).toBe(false)
    } finally {
      await rpc.processRegistry.reset()
    }
  })

  test("does not expose host persistence errors in session responses", async () => {
    let failSessionEndSave = false
    const rpc = new RPCHandler({ linkID: "link_test" })
    const sessions = new SessionManager({
      onChange: async ({ current }) => {
        if (failSessionEndSave && !current) {
          throw Object.assign(new Error("ENOENT: open '/private/host/.synergy-link/state.json'"), { code: "ENOENT" })
        }
      },
      onEnd: async (session) => {
        await rpc.processRegistry.releaseSession(session)
      },
    })
    const inbound = new SynergyLinkInboundHandler(rpc, sessions, async () => "approve")
    const host = { rpc, sessions, inbound }
    try {
      const sessionID = await openSession(host)
      failSessionEndSave = true

      const response = await inbound.handle({
        caller: callerA,
        body: {
          version: 2,
          requestID: "req_close_persistence_failure",
          linkID: "link_test",
          tool: "session",
          action: "close",
          payload: { action: "close", sessionID },
        },
      })

      expect(response.ok).toBe(false)
      if (!response.ok) {
        expect(response.requestID).toBe("req_close_persistence_failure")
        expect(response.error.code).toBe("host_internal_error")
        expect(response.error.message).not.toContain("/private/host")
        expect(response.error.message).not.toContain("ENOENT")
      }
    } finally {
      await rpc.processRegistry.reset()
    }
  })

  test("clamps remote yield below the transport deadline", async () => {
    const host = createHost()
    try {
      const sessionID = await openSession(host)
      const startedAt = Date.now()
      const response = await host.inbound.handle({
        caller: callerA,
        body: {
          version: 2,
          requestID: "req_yield_boundary",
          linkID: "link_test",
          tool: "bash",
          action: "execute",
          sessionID,
          payload: { command: "sleep 30", description: "yield boundary", yieldSeconds: 30 },
        },
      })
      expect(Date.now() - startedAt).toBeLessThan(25_000)
      expect(response.ok).toBe(true)
      if (response.ok && response.tool === "bash") {
        expect(response.result.metadata.background).toBe(true)
        expect(response.result.metadata.processId).toBeTruthy()
        expect(response.result.output).toContain("clamped")
      }
    } finally {
      await host.rpc.processRegistry.reset()
    }
  }, 30_000)
  function processIsAlive(pid: number | undefined): boolean {
    if (!pid) return false
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  async function waitForCondition(check: () => boolean | Promise<boolean>, timeoutMs = 3_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (!(await check())) {
      if (Date.now() >= deadline) throw new Error("Timed out waiting for host process state")
      await Bun.sleep(20)
    }
  }
})
