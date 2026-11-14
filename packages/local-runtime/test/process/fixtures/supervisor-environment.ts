import fs from "node:fs/promises"
import { runOwnedProcessWorker } from "../../../src/process/owned-worker"

const [marker, runner, configuration] = process.argv.slice(2)
if (runner === "__storage-worker-runner") {
  await import("@ericsanchezok/synergy-harness/storage/sqlite-worker")
  await new Promise(() => {})
}
await fs.writeFile(
  marker!,
  JSON.stringify({
    cwd: await fs.realpath(process.cwd()),
    home: process.env.HOME,
    root: process.env.SYNERGY_RUNTIME_ROOT,
    explicit: process.env.SYNERGY_FIXTURE_EXPLICIT,
    parent: process.env.SYNERGY_FIXTURE_PARENT,
    provider: process.env.OPENAI_API_KEY,
    injection: process.env.BASH_ENV,
    empty: process.env.SYNERGY_FIXTURE_EMPTY,
  }),
)
if (runner === "__owned-process-runner") {
  await runOwnedProcessWorker(configuration!)
  process.exit(0)
}
await new Promise(() => {})
