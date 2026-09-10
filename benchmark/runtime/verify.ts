import { createReadStream } from "node:fs"
import { loadComposition } from "./composition"
import { atomicJSON } from "./files"
import { RolloutArchive } from "@ericsanchezok/synergy-harness/session/rollout/archive"

const [archive, runtime, output] = process.argv.slice(2)
await (await loadComposition(runtime)).register()
const { manifest } = await RolloutArchive.inspect(Bun.file(archive))
const hash = new Bun.CryptoHasher("sha256")
for await (const chunk of createReadStream(archive)) hash.update(chunk)
const snapshots = manifest.snapshots
const issues = [...manifest.integrity.missing]
for (const snapshot of snapshots) {
  if (snapshot.gaps.length) issues.push("journal_gaps")
  if (snapshot.runs.some((run) => run.recording === "failed")) issues.push("recording_failed")
  if (
    [...snapshot.runs, ...snapshot.segments, ...snapshot.tools, ...snapshot.processes].some(
      (record) => record.status === "running",
    ) ||
    snapshot.calls.some((call) => call.status === "running") ||
    snapshot.attempts.some((attempt) => attempt.status === "running")
  )
    issues.push("unterminated_records")
}
const partial = !manifest.integrity.complete || manifest.artifacts.some((artifact) => artifact.ref.status === "partial")
await atomicJSON(output, {
  version: 1,
  valid: true,
  sha256: hash.digest("hex"),
  bytes: Bun.file(archive).size,
  integrity: manifest.integrity,
  recording: issues.length ? "failed" : partial ? "partial" : "complete",
  issues: [...new Set(issues)],
  counts: {
    files: manifest.files.length,
    artifacts: manifest.artifacts.length,
    calls: snapshots.reduce((n, snapshot) => n + snapshot.calls.length, 0),
  },
})
