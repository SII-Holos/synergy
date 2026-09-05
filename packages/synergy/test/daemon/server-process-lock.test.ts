import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { ServerProcessLock } from "../../src/util/server-process-lock"
import { DaemonPaths } from "../../src/util/daemon-paths"

type WorkerResult = { id: string; acquired?: boolean; ownerToken?: string; error?: string }

const children: Bun.Subprocess[] = []
const originalSynergyHome = process.env.SYNERGY_HOME

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null) child.kill()
    await child.exited.catch(() => {})
  }
  if (originalSynergyHome === undefined) delete process.env.SYNERGY_HOME
  else process.env.SYNERGY_HOME = originalSynergyHome
})

describe("ServerProcessLock", () => {
  test("allows exactly one of many processes to acquire concurrently", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-server-lock-"))
    const readyPath = path.join(home, "ready.log")
    const startPath = path.join(home, "start")
    const resultPath = path.join(home, "result.log")
    const releasePath = path.join(home, "release")
    const workerPath = path.join(import.meta.dirname, "server-process-lock-worker.ts")
    const count = 24
    const env = {
      ...process.env,
      SYNERGY_HOME: home,
      LOCK_READY_PATH: readyPath,
      LOCK_START_PATH: startPath,
      LOCK_RESULT_PATH: resultPath,
      LOCK_RELEASE_PATH: releasePath,
    }

    try {
      // Workers park on startPath until the start file appears, so every
      // worker can be spawned and readied before the competition begins;
      // readiness is bounded as one phase deadline, not a sum of per-worker
      // waits (see docs/postmortem/0006).
      for (let index = 0; index < count; index++) {
        children.push(
          Bun.spawn([process.execPath, "run", workerPath], {
            env: { ...env, LOCK_WORKER_ID: String(index) },
            stdout: "ignore",
            stderr: "inherit",
          }),
        )
      }

      const readyDeadline = Date.now() + 60_000
      const ready = new Set<string>()
      while (ready.size < count) {
        for (const line of (await fs.readFile(readyPath, "utf8").catch(() => "")).split("\n")) {
          if (line) ready.add(line)
        }
        if (ready.size >= count) break
        if (Date.now() >= readyDeadline) throw new Error(`Lock workers did not become ready (${ready.size}/${count})`)
        await Bun.sleep(50)
      }

      await Bun.write(startPath, "go\n")

      const resultDeadline = Date.now() + 60_000
      let results: WorkerResult[] = []
      while (results.length < count) {
        if (Date.now() >= resultDeadline) throw new Error("Lock workers did not finish competing")
        results = (await fs.readFile(resultPath, "utf8").catch(() => ""))
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as WorkerResult)
        await Bun.sleep(10)
      }

      const acquired = results.filter((result) => result.acquired)
      expect(acquired).toHaveLength(1)
      expect(acquired[0]?.ownerToken).toEqual(expect.any(String))
      expect(results.filter((result) => result.error)).toHaveLength(0)
      expect(results.filter((result) => result.acquired === false)).toHaveLength(count - 1)

      await Bun.write(releasePath, "release\n")
      expect(await Promise.all(children.map((child) => child.exited))).toEqual(Array(count).fill(0))
    } finally {
      await Bun.write(releasePath, "release\n").catch(() => {})
      await Promise.all(children.map((child) => child.exited.catch(() => -1)))
      await fs.rm(home, { recursive: true, force: true })
    }
  }, 150_000)

  test("recovers stale locks and rejects a reused pid with a different start identity", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-server-lock-stale-"))
    process.env.SYNERGY_HOME = home
    await fs.mkdir(DaemonPaths.root(), { recursive: true })

    try {
      const legacy = {
        pid: process.pid,
        startedAt: Date.now() - 10_000,
        command: ["legacy"],
        cwd: home,
        mode: "server" as const,
      }
      await fs.writeFile(DaemonPaths.runtimeLock(), JSON.stringify(legacy))
      let legacyError: unknown
      try {
        await ServerProcessLock.acquire()
      } catch (error) {
        legacyError = error
      }
      expect(legacyError).toBeInstanceOf(ServerProcessLock.AlreadyRunningError)
      await fs.rm(DaemonPaths.runtimeLock(), { force: true })

      const stale = {
        pid: 99_999_999,
        startedAt: Date.now() - 10_000,
        ownerToken: "stale-owner",
        processStartIdentity: "stale-process-start",
        command: ["stale"],
        cwd: home,
        mode: "server" as const,
      }
      await fs.writeFile(DaemonPaths.runtimeLock(), JSON.stringify(stale))

      const acquired = await ServerProcessLock.acquire()
      const current = await ServerProcessLock.read()
      expect(current?.ownerToken).not.toBe("stale-owner")
      expect(current?.processStartIdentity).toEqual(expect.any(String))
      await acquired.release()
      expect(await ServerProcessLock.read()).toBeUndefined()

      await fs.writeFile(DaemonPaths.runtimeLock(), JSON.stringify({ ...stale, pid: process.pid }))
      const reusedPid = await ServerProcessLock.acquire()
      expect((await ServerProcessLock.read())?.ownerToken).not.toBe("stale-owner")
      await reusedPid.release()
      expect(await ServerProcessLock.read()).toBeUndefined()
    } finally {
      await fs.rm(home, { recursive: true, force: true })
    }
  })

  test("waits for a half-written lock before deciding that it is stale", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-server-lock-partial-"))
    process.env.SYNERGY_HOME = home
    await fs.mkdir(DaemonPaths.root(), { recursive: true })

    try {
      const legacy = {
        pid: process.pid,
        startedAt: Date.now(),
        command: ["legacy"],
        cwd: home,
        mode: "server" as const,
      }
      const contents = JSON.stringify(legacy)
      await fs.writeFile(DaemonPaths.runtimeLock(), contents.slice(0, 12))
      expect(await ServerProcessLock.read()).toBeUndefined()
      const finishWrite = (async () => {
        await Bun.sleep(100)
        await fs.appendFile(DaemonPaths.runtimeLock(), contents.slice(12))
      })()

      let error: unknown
      try {
        await ServerProcessLock.acquire()
      } catch (caught) {
        error = caught
      }
      await finishWrite
      expect(error).toBeInstanceOf(ServerProcessLock.AlreadyRunningError)
      await fs.rm(DaemonPaths.runtimeLock(), { force: true })
    } finally {
      await fs.rm(home, { recursive: true, force: true })
    }
  })

  test("does not expose a half-written lock while publishing", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-server-lock-publish-race-"))
    const readyPath = path.join(home, "ready.log")
    const startPath = path.join(home, "start")
    const resultPath = path.join(home, "result.log")
    const releasePath = path.join(home, "release")
    const pausePath = path.join(home, "pause.log")
    const resumePublishPath = path.join(home, "resume-publish")
    const workerPath = path.join(import.meta.dirname, "server-process-lock-worker.ts")
    const env = {
      ...process.env,
      SYNERGY_HOME: home,
      LOCK_READY_PATH: readyPath,
      LOCK_START_PATH: startPath,
      LOCK_RESULT_PATH: resultPath,
      LOCK_RELEASE_PATH: releasePath,
      LOCK_RESUME_PUBLISH_PATH: resumePublishPath,
    }

    try {
      const pausedWorker = Bun.spawn([process.execPath, "run", workerPath], {
        env: { ...env, LOCK_WORKER_ID: "paused", LOCK_PAUSE_BEFORE_PUBLISH_PATH: pausePath },
        stdout: "ignore",
        stderr: "inherit",
      })
      children.push(pausedWorker)

      const readyDeadline = Date.now() + 10_000
      while (!(await fs.readFile(readyPath, "utf8").catch(() => "")).split("\n").includes("paused")) {
        if (Date.now() >= readyDeadline) throw new Error("Paused lock worker did not become ready")
        await Bun.sleep(10)
      }
      await Bun.write(startPath, "go\n")

      const pauseDeadline = Date.now() + 10_000
      while (!(await fs.readFile(pausePath, "utf8").catch(() => "")).split("\n").includes("paused")) {
        if (Date.now() >= pauseDeadline) throw new Error("Lock worker did not pause before publishing")
        await Bun.sleep(10)
      }

      const challenger = Bun.spawn([process.execPath, "run", workerPath], {
        env: { ...env, LOCK_WORKER_ID: "challenger" },
        stdout: "ignore",
        stderr: "inherit",
      })
      children.push(challenger)
      const challengerDeadline = Date.now() + 10_000
      while (!(await fs.readFile(readyPath, "utf8").catch(() => "")).split("\n").includes("challenger")) {
        if (Date.now() >= challengerDeadline) throw new Error("Challenger lock worker did not become ready")
        await Bun.sleep(10)
      }

      const resultDeadline = Date.now() + 10_000
      let results: WorkerResult[] = []
      while (results.length < 1) {
        if (Date.now() >= resultDeadline) throw new Error("Challenger did not acquire during publish pause")
        results = (await fs.readFile(resultPath, "utf8").catch(() => ""))
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as WorkerResult)
        await Bun.sleep(10)
      }

      expect(results).toHaveLength(1)
      expect(results[0]?.id).toBe("challenger")
      expect(results[0]?.acquired).toBe(true)

      await Bun.write(resumePublishPath, "resume\n")
      const completionDeadline = Date.now() + 10_000
      while (results.length < 2) {
        if (Date.now() >= completionDeadline) throw new Error("Paused lock worker did not finish competing")
        results = (await fs.readFile(resultPath, "utf8").catch(() => ""))
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as WorkerResult)
        await Bun.sleep(10)
      }

      await Bun.write(releasePath, "release\n")

      expect(await Promise.all(children.map((child) => child.exited))).toEqual([0, 0])
      expect(results.filter((result) => result.acquired)).toHaveLength(1)
      expect(results.find((result) => result.id === "paused")?.acquired).toBe(false)
      expect(results.filter((result) => result.error)).toHaveLength(0)
    } finally {
      await Bun.write(releasePath, "release\n").catch(() => {})
      await Promise.all(children.map((child) => child.exited.catch(() => -1)))
      await fs.rm(home, { recursive: true, force: true })
    }
  })

  test("blocks a stable schema-invalid lock instead of replacing it", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-server-lock-invalid-stable-"))
    process.env.SYNERGY_HOME = home
    await fs.mkdir(DaemonPaths.root(), { recursive: true })

    try {
      const contents = JSON.stringify({
        pid: process.pid,
        startedAt: Date.now(),
        command: ["schema-invalid"],
        cwd: home,
      })
      await fs.writeFile(DaemonPaths.runtimeLock(), contents)
      expect(await ServerProcessLock.read()).toBeUndefined()

      await expect(ServerProcessLock.acquire()).rejects.toMatchObject({
        name: "LockFileUncertainError",
        lockPath: DaemonPaths.runtimeLock(),
      })
      expect(await fs.readFile(DaemonPaths.runtimeLock(), "utf8")).toBe(contents)
      expect(await fs.readdir(DaemonPaths.root())).toEqual(["runtime-lock.json"])
    } finally {
      await fs.rm(home, { recursive: true, force: true })
    }
  })

  test("blocks conservatively on a stable malformed lock instead of replacing it", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-server-lock-malformed-stable-"))
    process.env.SYNERGY_HOME = home
    await fs.mkdir(DaemonPaths.root(), { recursive: true })

    try {
      const contents = `{"pid":${process.pid},"startedAt":${Date.now()},"command":["active"]`
      await fs.writeFile(DaemonPaths.runtimeLock(), contents)

      await expect(ServerProcessLock.acquire()).rejects.toMatchObject({
        name: "LockFileUncertainError",
        lockPath: DaemonPaths.runtimeLock(),
      })
      expect(await fs.readFile(DaemonPaths.runtimeLock(), "utf8")).toBe(contents)
      expect(await ServerProcessLock.read()).toBeUndefined()
    } finally {
      await fs.rm(home, { recursive: true, force: true })
    }
  })

  test("fails conservatively when the existing lock path stays unreadable", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-server-lock-unreadable-"))
    const readyPath = path.join(home, "ready.log")
    const startPath = path.join(home, "start")
    const resultPath = path.join(home, "result.log")
    const releasePath = path.join(home, "release")
    const workerPath = path.join(import.meta.dirname, "server-process-lock-worker.ts")

    try {
      const child = Bun.spawn([process.execPath, "run", workerPath], {
        env: {
          ...process.env,
          SYNERGY_HOME: home,
          LOCK_WORKER_ID: "unreadable",
          LOCK_READY_PATH: readyPath,
          LOCK_START_PATH: startPath,
          LOCK_RESULT_PATH: resultPath,
          LOCK_RELEASE_PATH: releasePath,
          LOCK_PREPARE_UNREADABLE: "1",
        },
        stdout: "ignore",
        stderr: "inherit",
      })
      children.push(child)

      const readyDeadline = Date.now() + 10_000
      while (!(await fs.readFile(readyPath, "utf8").catch(() => "")).includes("unreadable")) {
        if (Date.now() >= readyDeadline) throw new Error("Unreadable-lock worker did not become ready")
        await Bun.sleep(10)
      }
      await Bun.write(startPath, "go\n")

      const resultDeadline = Date.now() + 10_000
      let results: WorkerResult[] = []
      while (results.length === 0) {
        if (Date.now() >= resultDeadline) throw new Error("Unreadable-lock acquisition did not terminate")
        results = (await fs.readFile(resultPath, "utf8").catch(() => ""))
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as WorkerResult)
        await Bun.sleep(10)
      }

      expect(results[0]?.error).toContain("LockFileUncertainError")
      expect(await child.exited).toBe(1)
    } finally {
      await fs.rm(home, { recursive: true, force: true })
    }
  })

  test("allows only one process to replace a stale lock", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-server-lock-stale-race-"))
    const readyPath = path.join(home, "ready.log")
    const startPath = path.join(home, "start")
    const resultPath = path.join(home, "result.log")
    const releasePath = path.join(home, "release")
    const workerPath = path.join(import.meta.dirname, "server-process-lock-worker.ts")
    const count = 16
    const env = {
      ...process.env,
      SYNERGY_HOME: home,
      LOCK_READY_PATH: readyPath,
      LOCK_START_PATH: startPath,
      LOCK_RESULT_PATH: resultPath,
      LOCK_RELEASE_PATH: releasePath,
    }

    try {
      await fs.mkdir(path.join(home, "daemon"), { recursive: true })
      await fs.writeFile(
        path.join(home, "daemon", "runtime-lock.json"),
        JSON.stringify({
          pid: 99_999_999,
          startedAt: Date.now() - 10_000,
          command: ["stale"],
          cwd: home,
          mode: "server",
        }),
      )

      for (let index = 0; index < count; index++) {
        children.push(
          Bun.spawn([process.execPath, "run", workerPath], {
            env: { ...env, LOCK_WORKER_ID: String(index) },
            stdout: "ignore",
            stderr: "inherit",
          }),
        )
      }

      const readyDeadline = Date.now() + 60_000
      const ready = new Set<string>()
      while (ready.size < count) {
        for (const line of (await fs.readFile(readyPath, "utf8").catch(() => "")).split("\n")) {
          if (line) ready.add(line)
        }
        if (ready.size >= count) break
        if (Date.now() >= readyDeadline) throw new Error(`Lock workers did not become ready (${ready.size}/${count})`)
        await Bun.sleep(50)
      }

      await Bun.write(startPath, "go\n")
      const resultDeadline = Date.now() + 60_000
      let results: WorkerResult[] = []
      while (results.length < count) {
        if (Date.now() >= resultDeadline) throw new Error("Lock workers did not finish stale replacement")
        results = (await fs.readFile(resultPath, "utf8").catch(() => ""))
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as WorkerResult)
        await Bun.sleep(10)
      }

      expect(results.filter((result) => result.acquired)).toHaveLength(1)
      expect(results.filter((result) => result.error)).toHaveLength(0)
      await Bun.write(releasePath, "release\n")
      expect(await Promise.all(children.map((child) => child.exited))).toEqual(Array(count).fill(0))
    } finally {
      await Bun.write(releasePath, "release\n").catch(() => {})
      await Promise.all(children.map((child) => child.exited.catch(() => -1)))
      await fs.rm(home, { recursive: true, force: true })
    }
  }, 150_000)

  test("does not release a replacement lock with another process identity", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-server-lock-owner-"))
    process.env.SYNERGY_HOME = home

    try {
      const acquired = await ServerProcessLock.acquire()
      const current = await ServerProcessLock.read()
      expect(current).toBeDefined()
      await fs.writeFile(
        DaemonPaths.runtimeLock(),
        JSON.stringify({ ...current, processStartIdentity: "replacement-process-start" }),
      )

      await acquired.release()
      expect((await ServerProcessLock.read())?.processStartIdentity).toBe("replacement-process-start")
      await fs.rm(DaemonPaths.runtimeLock(), { force: true })
    } finally {
      await fs.rm(home, { recursive: true, force: true })
    }
  })
})
