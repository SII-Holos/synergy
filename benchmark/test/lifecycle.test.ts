import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { runProcess } from "../runtime/process"
import { readEvents } from "../runtime/events"

test("process deadlines retain nonzero, signal and timeout independently", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bench-process-"))
  try {
    const failed = await runProcess({
      command: [process.execPath, "-e", "process.exit(7)"],
      log: path.join(root, "failed.log"),
      timeoutMs: 10000,
    })
    expect(failed).toMatchObject({ exit_code: 7, timed_out: false, signal: null })
    const timeout = await runProcess({
      command: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
      log: path.join(root, "timeout.log"),
      timeoutMs: 100,
    })
    expect(timeout.timed_out).toBe(true)
    expect(timeout.signal).toBe("SIGKILL")
    expect(timeout.ended_at).toBeGreaterThanOrEqual(timeout.started_at)
    expect(await readFile(path.join(root, "failed.log"), "utf8")).toBe("")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("incremental event reading retains terminal identity through a truncated tail", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bench-events-"))
  try {
    const file = path.join(root, "events.jsonl")
    await Bun.write(
      file,
      '{"sessionID":"s","runID":"r"}\n' +
        '{"type":"progress","text":"' +
        "x".repeat(8 * 1024 * 1024) +
        '"}\n{"type":"failed","outcome":"timeout"}\n{"type":',
    )
    expect(await readEvents(file)).toMatchObject({
      identity: { sessionID: "s", runID: "r" },
      terminal: { outcome: "timeout" },
      invalid_lines: 1,
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("export deadlines and failures remain independent from agent success", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bench-export-"))
  try {
    for (const file of ["export.ts", "process.ts", "files.ts"])
      await Bun.write(path.join(root, file), Bun.file(path.join(import.meta.dir, "../runtime", file)))
    const { exportRollout } = await import(path.join(root, "export.ts"))
    for (const fault of ["export-exit", "export-timeout", "validation-exit", "validation-timeout", "success"]) {
      const logs = path.join(root, fault)
      await mkdir(logs)
      await Bun.write(
        path.join(root, "entry.ts"),
        fault === "export-exit"
          ? "process.exit(7)"
          : fault === "export-timeout"
            ? "setInterval(() => {}, 1000)"
            : 'await Bun.write(process.argv.at(-1)!, "retained archive")',
      )
      await Bun.write(
        path.join(root, "verify.ts"),
        fault === "validation-exit"
          ? "process.exit(6)"
          : fault === "validation-timeout"
            ? "setInterval(() => {}, 1000)"
            : 'if (await Bun.file(process.argv[2]).text() !== "retained archive") process.exit(8)',
      )
      const result = await exportRollout({
        logs,
        runtime: "core",
        env: process.env,
        identity: { sessionID: "s", runID: "r" },
        timeoutSeconds: 0.4,
      })
      expect(result.status).toBe(fault === "success" ? "completed" : "failed")
      expect(await Bun.file(path.join(logs, "export.json")).json()).toEqual(result)
      expect(result.ended_at).toBeGreaterThanOrEqual(result.started_at)
      if (fault === "export-exit") expect(result.process.exit_code).toBe(7)
      if (fault === "export-timeout") expect(result.process.timed_out).toBe(true)
      if (fault === "validation-exit") expect(result.validation.exit_code).toBe(6)
      if (fault === "validation-timeout") expect(result.validation.timed_out).toBe(true)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
