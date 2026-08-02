import { afterEach, describe, expect, test } from "bun:test"
import { spawn, type ChildProcess } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Platform, SYNERGY_LINK_PROCESS_OWNER_ENV } from "../src/platform"

const roots = new Set<string>()
const workerPids = new Set<number>()

afterEach(async () => {
  for (const pid of workerPids) {
    try {
      process.kill(-pid, "SIGKILL")
    } catch {
      try {
        process.kill(pid, "SIGKILL")
      } catch {}
    }
  }
  workerPids.clear()
  await Promise.all([...roots].map((root) => rm(root, { recursive: true, force: true })))
  roots.clear()
})

describe("Platform.killTree", () => {
  test.skipIf(process.platform === "win32")(
    "reaps an owner-marked detached descendant after its tracked launcher exits",
    async () => {
      const launched = await launchDetachedWorker("owned")
      expect(isProcessAlive(launched.workerPid)).toBe(true)

      await Platform.killTree(launched.launcher, () => launched.launcher.exitCode !== null, {
        ownerMarker: launched.ownerMarker,
      })

      await waitFor(() => !isProcessAlive(launched.workerPid))
      workerPids.delete(launched.workerPid)
    },
    10_000,
  )

  test.skipIf(process.platform === "win32")("reaps detached descendants for multiple owner markers", async () => {
    const first = await launchDetachedWorker("batch-first")
    const second = await launchDetachedWorker("batch-second")

    await Platform.killOwnedByMarkers([first.ownerMarker, second.ownerMarker])

    await Promise.all([
      waitFor(() => !isProcessAlive(first.workerPid)),
      waitFor(() => !isProcessAlive(second.workerPid)),
    ])
    workerPids.delete(first.workerPid)
    workerPids.delete(second.workerPid)
  })

  test.skipIf(process.platform === "win32")("does not reap a process owned by a different marker", async () => {
    const launched = await launchDetachedWorker("isolated")

    await Platform.killOwnedByMarker(launched.ownerMarker.slice(0, -4))
    expect(isProcessAlive(launched.workerPid)).toBe(true)

    await Platform.killOwnedByMarker(`${launched.ownerMarker}-other`)
    expect(isProcessAlive(launched.workerPid)).toBe(true)

    await Platform.killOwnedByMarker(launched.ownerMarker)
    await waitFor(() => !isProcessAlive(launched.workerPid))
    workerPids.delete(launched.workerPid)
  })
})

async function launchDetachedWorker(label: string): Promise<{
  launcher: ChildProcess
  ownerMarker: string
  workerPid: number
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), `synergy-link-killtree-${label}-`))
  roots.add(root)
  const pidPath = path.join(root, "worker.pid")
  const workerPath = path.join(root, "worker.ts")
  const launcherPath = path.join(root, "launcher.ts")
  const ownerMarker = crypto.randomUUID()

  await Bun.write(workerPath, "setInterval(() => {}, 1_000)\n")
  await Bun.write(
    launcherPath,
    `const child = Bun.spawn([process.execPath, ${JSON.stringify(workerPath)}], {\n  env: process.env,\n  stdin: "ignore",\n  stdout: "ignore",\n  stderr: "ignore",\n  detached: true,\n})\nchild.unref()\nawait Bun.write(${JSON.stringify(pidPath)}, String(child.pid))\n`,
  )

  const launcher = spawn(process.execPath, [launcherPath], {
    env: { ...process.env, [SYNERGY_LINK_PROCESS_OWNER_ENV]: ownerMarker },
    stdio: "ignore",
    detached: true,
  })
  await waitFor(() => launcher.exitCode !== null)
  await waitFor(async () => Bun.file(pidPath).exists())
  const workerPid = Number(await Bun.file(pidPath).text())
  if (!Number.isSafeInteger(workerPid) || workerPid <= 0) throw new Error("Detached worker did not report a PID")
  workerPids.add(workerPid)
  await waitFor(() => isProcessAlive(workerPid))
  return { launcher, ownerMarker, workerPid }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for process state")
    await Bun.sleep(20)
  }
}
