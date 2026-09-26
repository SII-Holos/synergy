import { spawn } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { mkdir, readFile, writeFile, unlink, lstat, open, copyFile, symlink } from "node:fs/promises"
import { createReadStream } from "node:fs"
import { createInterface } from "node:readline"
import path from "node:path"
import { nativeOutcome } from "./native-outcome.mjs"
import { executionDeadline } from "./deadline.mjs"

const [optionsFile, instructionFile, logs, credentialFile] = process.argv.slice(2)
const options = JSON.parse(await readFile(optionsFile, "utf8"))
const native = options.native
const home = path.join(logs, "home")
let credentials = {}
try {
  const stat = await lstat(credentialFile)
  if (!stat.isFile() || (stat.mode & 0o777) !== 0o600) throw new Error("Invalid credential file")
  credentials = JSON.parse(await readFile(credentialFile, "utf8"))
} finally {
  await unlink(credentialFile)
}
await mkdir(home, { recursive: true, mode: 0o700 })
if (options.harness === "opencode") {
  // OpenCode's native npm service skips reification when the pinned lock and modules are present.
  // https://github.com/anomalyco/opencode/blob/v1.18.30/packages/core/src/npm.ts
  const config = path.join(home, ".config/opencode")
  await mkdir(config, { recursive: true })
  for (const name of ["package.json", "package-lock.json"]) {
    await copyFile(path.join("/opt/synergy/engine", name), path.join(config, name))
  }
  await symlink("/opt/synergy/engine/node_modules", path.join(config, "node_modules"))
}
async function atomic(name, data) {
  const file = path.join(logs, name)
  const temporary = file + "." + randomUUID()
  const handle = await open(temporary, "wx", 0o600)
  try {
    await handle.writeFile(JSON.stringify(data, null, 2) + "\n")
    await handle.sync()
  } finally {
    await handle.close()
  }
  const { rename } = await import("node:fs/promises")
  await rename(temporary, file)
  const directory = await open(logs, "r")
  try {
    await directory.sync()
  } finally {
    await directory.close()
  }
}
await writeFile(path.join(logs, "runner.pid"), String(process.pid))
for (const [name, content] of Object.entries(native.files)) {
  const file = path.resolve(home, name)
  if (!file.startsWith(home + path.sep)) throw new Error("Configuration escapes isolated home")
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, content, { mode: 0o600 })
}
const env = {
  ...process.env,
  ...credentials,
  ...native.env,
  ...(options.harness === "synergy"
    ? {}
    : {
        HOME: home,
        XDG_CONFIG_HOME: path.join(home, ".config"),
        XDG_DATA_HOME: path.join(home, ".local/share"),
        XDG_CACHE_HOME: path.join(home, ".cache"),
      }),
  PATH: `/opt/synergy/bin:/opt/synergy/node/bin:${process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin"}`,
}
const capture =
  options.runtime_protocol === "synergy-session-v1"
    ? (await import("./session-relay.mjs")).startSessionCapture({
        root: path.join(home, "native-wire"),
        endpoint: native.env.BENCH_GATEWAY_BASE,
      })
    : undefined
if (capture) env.BENCH_CAPTURE_ENDPOINT = capture.url
const stdout = await open(path.join(logs, "events.jsonl"), "w", 0o600)
const stderr = await open(path.join(logs, "stderr.log"), "w", 0o600)
const started = Date.now()
const child = spawn(native.argv[0], [...native.argv.slice(1), await readFile(instructionFile, "utf8")], {
  env,
  detached: true,
  stdio: ["ignore", stdout.fd, stderr.fd],
})
let timedOut = false
let interrupted = false
let forced = false
let stopping = false
let forceTimer
function signal(value) {
  if (!child.pid) return
  try {
    process.kill(-child.pid, value)
  } catch (error) {
    if (error.code !== "ESRCH") throw error
  }
}
function stop() {
  if (stopping) return
  stopping = true
  void capture?.close(options.cleanup_seconds, true)
  signal("SIGTERM")
  forceTimer = setTimeout(() => {
    forced = true
    signal("SIGKILL")
  }, options.cleanup_seconds * 1000)
}
const cancel = () => {
  interrupted = true
  stop()
}
process.on("SIGTERM", cancel)
process.on("SIGINT", cancel)
const executionClock = executionDeadline({
  marker: options.execution_marker,
  startupSeconds: options.startup_timeout_seconds,
  agentSeconds: options.timeout_seconds,
  onTimeout: () => {
    timedOut = true
    stop()
  },
})
const result = await new Promise((resolve) => {
  child.once("error", (error) => resolve({ code: null, error: error.code ?? error.name }))
  child.once("exit", (code, signal) => resolve({ code, signal }))
})
const ended = Date.now()
await executionClock.stop()
clearTimeout(forceTimer)
signal("SIGKILL")
const captureCleanup = await capture?.close(options.cleanup_seconds, timedOut || interrupted || forced)
await stdout.sync()
await stdout.close()
await stderr.sync()
await stderr.close()
const events = createInterface({ input: createReadStream(path.join(logs, "events.jsonl")), crlfDelay: Infinity })
let nativeResult = { status: "unknown", error: null }
let malformedEvents = 0
for await (const line of events) {
  try {
    const observed = nativeOutcome(options.harness, [JSON.parse(line)])
    if (observed.status !== "unknown") nativeResult = observed
  } catch {
    malformedEvents++
  }
}
const outcome = interrupted
  ? "cancelled"
  : timedOut
    ? "timeout"
    : result.code !== 0
      ? "failed"
      : ["failed", "cancelled"].includes(nativeResult.status)
        ? nativeResult.status
        : options.runtime_protocol === "synergy-session-v1" && nativeResult.status !== "completed"
          ? "failed"
          : "completed"
await atomic("execution.json", {
  version: 3,
  harness: options.harness,
  runtime_protocol: options.runtime_protocol ?? null,
  started_at: started,
  ended_at: Date.now(),
  native_ended_at: ended,
  native_wall_ms: ended - started,
  capture_cleanup: captureCleanup ?? null,
  exit_code: result.code,
  signal: result.signal ?? null,
  error: result.error ?? null,
  outcome,
  native_terminal: nativeResult,
  malformed_events: malformedEvents,
  timed_out: timedOut,
  interrupted,
  forced,
  wall_ms: Date.now() - started,
  lifecycle: executionClock.state,
})
const archiveStarted = Date.now()
const archiveFile = path.join(logs, "rollout.tar.gz")
const archive = spawn(
  "tar",
  ["-czf", archiveFile, "-C", logs, "home", "events.jsonl", "stderr.log", "execution.json"],
  {
    stdio: ["ignore", "ignore", "ignore"],
    detached: true,
  },
)
let archiveTimeout = false
const archiveDeadline = setTimeout(() => {
  archiveTimeout = true
  try {
    process.kill(-archive.pid, "SIGKILL")
  } catch {}
}, options.export_timeout_seconds * 1000)
const code = await new Promise((resolve) => {
  archive.once("error", () => resolve(null))
  archive.once("exit", (code) => resolve(code))
})
clearTimeout(archiveDeadline)
await atomic("export.json", {
  status: code === 0 ? "completed" : "failed",
  timed_out: archiveTimeout,
  started_at: archiveStarted,
  ended_at: Date.now(),
  format: "native-home-tar-v1",
})
if (code === 0) {
  const hash = createHash("sha256")
  let size = 0
  for await (const chunk of createReadStream(archiveFile)) {
    hash.update(chunk)
    size += chunk.byteLength
  }
  await atomic("archive.json", {
    valid: true,
    format: "native-home-tar-v1",
    filename: "rollout.tar.gz",
    recording: forced || captureCleanup?.timed_out ? "partial" : "complete",
    bytes: size,
    sha256: hash.digest("hex"),
  })
}
await writeFile(path.join(logs, "finished"), "done\n")
process.exitCode = outcome === "completed" ? 0 : 1
