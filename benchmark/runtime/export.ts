import path from "node:path"
import { atomicJSON } from "./files"
import { runProcess } from "./process"

export async function exportRollout(input: {
  logs: string
  env: NodeJS.ProcessEnv
  runtime: string
  identity?: { sessionID: string; runID: string }
  timeoutSeconds: number
  validationTimeoutSeconds?: number
}) {
  const started_at = Date.now()
  const output = path.join(input.logs, "rollout.zip")
  const record = path.join(input.logs, "export.json")
  const validationTimeoutSeconds = input.validationTimeoutSeconds ?? 300
  const base = {
    version: 1,
    started_at,
    output,
    timeout_seconds: input.timeoutSeconds,
    validation_timeout_seconds: validationTimeoutSeconds,
  }
  await atomicJSON(record, { ...base, status: "running" })
  try {
    if (!input.identity) throw new Error("No session/run identity available for export")
    const result = await runProcess({
      command: [
        process.execPath,
        path.join(import.meta.dir, "entry.ts"),
        "export",
        input.identity.sessionID,
        "--run",
        input.identity.runID,
        "--format",
        "rollout",
        "--output",
        output,
      ],
      env: input.env,
      log: path.join(input.logs, "export.log"),
      timeoutMs: input.timeoutSeconds * 1000,
    })
    const validation =
      result.exit_code === 0 && !result.timed_out
        ? await runProcess({
            command: [
              process.execPath,
              path.join(import.meta.dir, "verify.ts"),
              output,
              input.runtime,
              path.join(input.logs, "archive.json"),
            ],
            env: input.env,
            log: path.join(input.logs, "validation.log"),
            timeoutMs: validationTimeoutSeconds * 1000,
          })
        : null
    const status =
      result.exit_code === 0 && !result.timed_out && validation?.exit_code === 0 && !validation.timed_out
        ? "completed"
        : "failed"
    const value = { ...base, status, ended_at: Date.now(), process: result, validation }
    await atomicJSON(record, value)
    return value
  } catch (error) {
    const value = {
      ...base,
      status: "failed",
      ended_at: Date.now(),
      process: null,
      validation: null,
      error: error instanceof Error ? error.message : String(error),
    }
    await atomicJSON(record, value)
    return value
  }
}
