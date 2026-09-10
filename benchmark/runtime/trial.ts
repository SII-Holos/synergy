import { lstat, mkdir, open, unlink } from "node:fs/promises"
import path from "node:path"
import { readEvents } from "./events"
import { atomicJSON } from "./files"
import { exportRollout } from "./export"
import { terminate } from "./process"

const [optionsFile, instructionFile, logs, credentialFile] = process.argv.slice(2)
let credentials: Record<string, string> = {}
if (credentialFile) {
  try {
    const stat = await lstat(credentialFile)
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600)
      throw new Error("Credential file must be a regular file with mode 0600")
    credentials = await Bun.file(credentialFile).json()
    if (
      Object.entries(credentials).some(
        ([key, value]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== "string",
      )
    )
      throw new Error("Invalid credential mapping")
  } finally {
    await unlink(credentialFile)
  }
}
const options = await Bun.file(optionsFile).json()
await mkdir(logs, { recursive: true })
await Bun.write(path.join(logs, "runner.pid"), String(process.pid))
const env = {
  ...process.env,
  ...credentials,
  PATH: `/opt/synergy/bin:${process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin"}`,
  SYNERGY_HOME: path.join(logs, "home"),
  SYNERGY_CONFIG: options.config,
  SYNERGY_CONFIG_CONTENT: "{}",
  SYNERGY_BENCH_COMPOSITION: options.runtime,
  SYNERGY_DISABLE_AUTOUPDATE: "1",
  SYNERGY_DISABLE_DEFAULT_PLUGINS: "1",
  SYNERGY_DISABLE_MODELS_FETCH: "1",
  MODELS_DEV_API_JSON: "/opt/synergy/source/packages/testing/fixtures/models-api.json",
}
const args = [
  "send",
  await Bun.file(instructionFile).text(),
  "--model",
  options.model,
  "--agent",
  options.agent,
  "--format",
  "json",
  "--non-interactive",
  "--timeout",
  String(options.timeout_seconds),
]
if (options.variant) args.push("--variant", options.variant)
if (options.experiment) args.push("--experiment", options.experiment)
const output = await open(path.join(logs, "events.jsonl"), "w")
const errors = await open(path.join(logs, "stderr.log"), "w")
const start = Date.now()
const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "entry.ts"), ...args], {
  env,
  stdin: "ignore",
  stdout: output.fd,
  stderr: errors.fd,
  detached: true,
})
let interrupted = false
let timedOut = false
let forced = false
let stopping = false
let forceTimer: ReturnType<typeof setTimeout> | undefined
function stop() {
  if (stopping || child.exitCode !== null) return
  stopping = true
  terminate(child, "SIGTERM")
  forceTimer = setTimeout(() => {
    forced = true
    terminate(child, "SIGKILL")
  }, options.cleanup_seconds * 1000)
}
const cancel = () => {
  interrupted = true
  stop()
}
process.on("SIGTERM", cancel)
process.on("SIGINT", cancel)
const deadline = setTimeout(() => {
  timedOut = true
  stop()
}, options.timeout_seconds * 1000)
const exitCode = await child.exited
clearTimeout(deadline)
clearTimeout(forceTimer)
await output.close()
await errors.close()
const { terminal, identity, invalid_lines } = await readEvents(path.join(logs, "events.jsonl"))
await atomicJSON(path.join(logs, "execution.json"), {
  version: 2,
  started_at: start,
  ended_at: Date.now(),
  exit_code: exitCode,
  signal: child.signalCode ?? null,
  outcome: timedOut && !interrupted ? "timeout" : (terminal?.outcome ?? (interrupted ? "cancelled" : "interrupted")),
  timed_out: timedOut,
  interrupted,
  forced,
  wall_ms: Date.now() - start,
  session_id: identity?.sessionID ?? null,
  run_id: identity?.runID ?? null,
  terminal: terminal ?? null,
  invalid_event_lines: invalid_lines,
})
const result = terminal?.result
if (result && typeof result === "object" && "accounting" in result)
  await atomicJSON(path.join(logs, "accounting.json"), result.accounting)
const exported = await exportRollout({
  logs,
  env,
  runtime: options.runtime,
  identity,
  timeoutSeconds: options.export_timeout_seconds,
})
await Bun.write(path.join(logs, "finished"), "\n")
process.exit(exported.status === "completed" ? exitCode : 1)
