#!/usr/bin/env bun

import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { networkInterfaces, tmpdir } from "node:os"
import path from "node:path"
import { chromium } from "playwright"

const appDirectory = path.resolve(import.meta.dir, "..")
const repositoryRoot = path.resolve(appDirectory, "../..")
const synergyDirectory = path.join(repositoryRoot, "packages", "synergy")
const appDist = path.join(appDirectory, "dist", "index.html")

if (!(await Bun.file(appDist).exists())) {
  throw new Error("packages/app/dist is missing; run `bun run --cwd packages/app build` first")
}

const hostname = nonLoopbackIPv4()
const port = reservePort(hostname)
const temporaryRoot = await mkdtemp(path.join(tmpdir(), "synergy-private-http-"))
const workspace = path.join(temporaryRoot, "workspace")
let server: ReturnType<typeof Bun.spawn> | undefined
let serverOutput: ReturnType<typeof captureTail> | undefined
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined

try {
  await mkdir(path.join(temporaryRoot, ".synergy"), { recursive: true })
  await mkdir(workspace, { recursive: true })

  server = Bun.spawn({
    cmd: [
      process.execPath,
      "run",
      "--conditions=browser",
      "./src/index.ts",
      "server",
      "--port",
      String(port),
      "--hostname",
      hostname,
      "--non-interactive",
      "--no-banner",
    ],
    cwd: synergyDirectory,
    env: isolatedEnvironment(temporaryRoot, workspace, hostname),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const stdout = server.stdout
  const stderr = server.stderr
  if (!(stdout instanceof ReadableStream) || !(stderr instanceof ReadableStream)) {
    throw new Error("Temporary Synergy server output pipes are unavailable")
  }
  serverOutput = captureTail(stdout, stderr)
  await waitForHealth(`http://${hostname}:${port}`, server)

  browser = await chromium.launch({ headless: true })
  const page = await browser.newPage()
  const pageErrors: string[] = []
  page.on("pageerror", (error) => pageErrors.push(error.message))

  const url = `http://${hostname}:${port}`
  const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 })
  if (!response?.ok()) throw new Error(`Private HTTP navigation failed with status ${response?.status() ?? "unknown"}`)

  await page.waitForFunction(() => document.getElementById("synergy-app-boot") === null, undefined, { timeout: 60_000 })
  const result = await page.evaluate(() => ({
    isSecureContext: globalThis.isSecureContext,
    randomUUID: typeof globalThis.crypto?.randomUUID,
    getRandomValues: typeof globalThis.crypto?.getRandomValues,
    rootChildren: document.getElementById("root")?.childElementCount ?? 0,
  }))

  if (result.isSecureContext) throw new Error(`Expected a non-Secure Context at ${url}`)
  if (result.randomUUID !== "undefined") throw new Error(`Expected crypto.randomUUID to be unavailable at ${url}`)
  if (result.getRandomValues !== "function")
    throw new Error(`Expected crypto.getRandomValues to remain available at ${url}`)
  if (result.rootChildren === 0) throw new Error("Synergy App root did not render")
  if (pageErrors.length > 0) throw new Error(`Synergy App raised page errors: ${pageErrors.join("; ")}`)

  console.log(JSON.stringify({ url, ...result, pageErrors }, null, 2))
} catch (error) {
  const detail = serverOutput?.value ? `\nServer output:\n${sanitize(serverOutput.value, temporaryRoot)}` : ""
  throw new Error(`${error instanceof Error ? error.message : String(error)}${detail}`, { cause: error })
} finally {
  await browser?.close().catch(() => {})
  if (server && server.exitCode === null) await stopProcess(server)
  await serverOutput?.done.catch(() => {})
  await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
}

function nonLoopbackIPv4() {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal && entry.address !== "0.0.0.0") return entry.address
    }
  }
  throw new Error("A non-loopback IPv4 address is required for the private HTTP smoke test")
}

function reservePort(hostname: string) {
  const probe = Bun.serve({ hostname, port: 0, fetch: () => new Response(null, { status: 503 }) })
  const port = probe.port
  probe.stop(true)
  return port
}

function isolatedEnvironment(home: string, cwd: string, hostname: string) {
  const env: Record<string, string> = {}
  for (const key of [
    "PATH",
    "PATHEXT",
    "SystemRoot",
    "WINDIR",
    "COMSPEC",
    "TMPDIR",
    "TMP",
    "TEMP",
    "LANG",
    "LANGUAGE",
    "LC_ALL",
    "LC_CTYPE",
    "TZ",
  ]) {
    const value = process.env[key]
    if (value !== undefined) env[key] = value
  }
  return {
    ...env,
    SYNERGY_HOME: home,
    SYNERGY_CWD: cwd,
    SYNERGY_CONFIG_CONTENT: "{}",
    SYNERGY_DISABLE_LSP_DOWNLOAD: "1",
    SYNERGY_DISABLE_BUILTIN_MCP: "1",
    NO_PROXY: `localhost,127.0.0.1,::1,${hostname}`,
  }
}

async function waitForHealth(baseUrl: string, child: ReturnType<typeof Bun.spawn>) {
  const deadline = Date.now() + 60_000
  let lastError = ""
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Synergy server exited during startup with code ${child.exitCode}`)
    try {
      const response = await fetch(`${baseUrl}/global/health`, { signal: AbortSignal.timeout(1_000) })
      if (response.ok) return
      lastError = `HTTP ${response.status}`
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
    await Bun.sleep(250)
  }
  throw new Error(`Timed out waiting for temporary Synergy health${lastError ? `: ${lastError}` : ""}`)
}

function captureTail(...streams: ReadableStream<Uint8Array>[]) {
  let value = ""
  const done = Promise.all(
    streams.map(async (stream) => {
      const decoder = new TextDecoder()
      const reader = stream.getReader()
      while (true) {
        const item = await reader.read()
        if (item.done) break
        value = (value + decoder.decode(item.value, { stream: true })).slice(-16_384)
      }
      reader.releaseLock()
    }),
  ).then(() => undefined)
  return {
    get value() {
      return value
    },
    done,
  }
}

async function stopProcess(child: ReturnType<typeof Bun.spawn>) {
  if (child.exitCode !== null) return
  child.kill()
  const exited = await Promise.race([child.exited.then(() => true), Bun.sleep(5_000).then(() => false)])
  if (exited) return
  child.kill("SIGKILL")
  await child.exited
}

function sanitize(value: string, root: string) {
  return value.replaceAll(root, "<temporary-home>").slice(-8_192)
}
