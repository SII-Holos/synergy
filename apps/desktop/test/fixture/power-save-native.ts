import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { createServer } from "node:http"
import { promisify } from "node:util"
import { app, BrowserWindow, powerSaveBlocker } from "electron"
import { createDesktopActivityGroup, createDesktopPowerGuard, fetchDesktopActivity } from "../../src/power-save"

const runCommand = promisify(execFile)
app.on("window-all-closed", () => {})
void run()
  .then(() => app.quit())
  .catch((error) => {
    console.error(error)
    app.exit(1)
  })

async function until(label: string, predicate: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 3_000
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error(`Native power state did not settle: ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

async function assertionCount() {
  const { stdout } = await runCommand("/usr/bin/pmset", ["-g", "assertions"])
  return stdout
    .split("\n")
    .filter((line) => line.includes(`pid ${process.pid}(`) && line.includes("NoIdleSleepAssertion")).length
}

async function run() {
  await app.whenReady()
  const reads = new Set<string>()
  const server = createServer((request, response) => {
    const member = request.url?.match(/^\/(a|b)\/global\/activity$/)?.[1]
    if (!member || request.headers.authorization !== `Bearer fixture-${member}`) {
      response.writeHead(401).end()
      return
    }
    reads.add(member)
    response.setHeader("content-type", "application/json")
    response.end(JSON.stringify({ active: true, sessions: 1, backgroundJobs: 0 }))
  })
  const guard = createDesktopPowerGuard(powerSaveBlocker)
  const errors: unknown[] = []
  const group = createDesktopActivityGroup({
    intervalMs: 60_000,
    failureGraceMs: 0,
    releaseDebounceMs: 0,
    onDesiredChange: (desired) => guard.apply(desired),
    onError: (error) => errors.push(error),
  })
  const release = () => {
    group.stop()
    guard.release()
  }
  app.on("before-quit", release)
  let window: BrowserWindow | undefined
  let success = false
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(0, "127.0.0.1", resolve)
    })
    const address = server.address()
    assert(address && typeof address !== "string")
    const source = (member: string) =>
      group.add({
        resolveBaseUrl: () => `http://127.0.0.1:${address.port}/${member}`,
        fetchActivity: (url, signal) =>
          fetchDesktopActivity(url, signal, { authorization: `Bearer fixture-${member}` }),
      })
    const removeA = source("a")
    const removeB = source("b")
    assert.equal(guard.active(), false)
    assert.equal(await assertionCount(), 0)
    assert.equal(reads.size, 0)
    group.start()
    await until("both member activities", () => {
      if (errors.length) throw new AggregateError(errors, "Native activity requests failed")
      return reads.size === 2 && guard.active()
    })
    await until("initial assertion", async () => (await assertionCount()) === 1)
    window = new BrowserWindow({
      show: false,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    })
    window.close()
    await until("closed window", () => window!.isDestroyed())
    assert.equal(guard.active(), true)
    assert.equal(await assertionCount(), 1)
    removeA()
    assert.equal(await assertionCount(), 1)
    group.stop()
    await until("disabled setting", async () => (await assertionCount()) === 0)
    group.start()
    await until("enabled setting", async () => guard.active() && (await assertionCount()) === 1)
    removeB()
    await until("last member removed", async () => (await assertionCount()) === 0)
    source("b")
    await until("active member before quit", async () => guard.active() && (await assertionCount()) === 1)
    assert.deepEqual(errors, [])
    success = true
    console.log("Native member power checks passed")
  } finally {
    if (window && !window.isDestroyed()) window.destroy()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    if (!success) release()
  }
}
