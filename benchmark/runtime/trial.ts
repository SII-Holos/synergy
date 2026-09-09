import { mkdir, open } from "node:fs/promises"
import path from "node:path"

const [optionsFile, instructionFile, logs] = process.argv.slice(2)
const options = await Bun.file(optionsFile).json()
await mkdir(logs, { recursive: true })
await Bun.write(path.join(logs, "runner.pid"), String(process.pid))
const env = {
  ...process.env,
  SYNERGY_HOME: path.join(logs, "home"),
  SYNERGY_CONFIG: options.config,
  SYNERGY_CONFIG_CONTENT: "{}",
  SYNERGY_BENCH_COMPOSITION: options.runtime,
  SYNERGY_DISABLE_AUTOUPDATE: "1",
  SYNERGY_DISABLE_DEFAULT_PLUGINS: "1",
  SYNERGY_DISABLE_MODELS_FETCH: "1",
}
const entry = path.join(import.meta.dir, "entry.ts")
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
const child = Bun.spawn([process.execPath, entry, ...args], {
  env,
  stdin: "ignore",
  stdout: output.fd,
  stderr: errors.fd,
})
const stop = () => child.kill("SIGTERM")
process.once("SIGTERM", stop)
process.once("SIGINT", stop)
const deadline = setTimeout(stop, (options.timeout_seconds + options.cleanup_seconds / 2) * 1000)
const kill = setTimeout(() => child.kill("SIGKILL"), (options.timeout_seconds + options.cleanup_seconds * 0.75) * 1000)
const exitCode = await child.exited
clearTimeout(deadline)
clearTimeout(kill)
await output.close()
await errors.close()
const events = (await Bun.file(path.join(logs, "events.jsonl")).text()).split("\n").flatMap((line) => {
  try {
    return [JSON.parse(line)]
  } catch {
    return []
  }
})
const terminal = events.findLast((event) => event.type === "result" || event.type === "failed")
const identity = events.findLast((event) => event.sessionID && event.runID)
await Bun.write(
  path.join(logs, "execution.json"),
  JSON.stringify({
    version: 1,
    exit_code: exitCode,
    outcome: terminal?.outcome ?? "interrupted",
    wall_ms: Date.now() - start,
    session_id: identity?.sessionID ?? null,
    run_id: identity?.runID ?? null,
    terminal: terminal ?? null,
  }),
)
if (terminal?.result?.accounting)
  await Bun.write(path.join(logs, "accounting.json"), JSON.stringify(terminal.result.accounting))
if (identity) {
  const exportLog = await open(path.join(logs, "export.log"), "w")
  const exporter = Bun.spawn(
    [
      process.execPath,
      entry,
      "export",
      identity.sessionID,
      "--run",
      identity.runID,
      "--format",
      "rollout",
      "--output",
      path.join(logs, "rollout.zip"),
    ],
    { env, stdin: "ignore", stdout: exportLog.fd, stderr: exportLog.fd },
  )
  const timer = setTimeout(() => exporter.kill("SIGKILL"), options.cleanup_seconds * 250)
  await exporter.exited
  clearTimeout(timer)
  await exportLog.close()
}
await Bun.write(path.join(logs, "finished"), "\n")
process.exit(exitCode)
