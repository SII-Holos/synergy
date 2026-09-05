import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"

type WorkerReport = {
  sessionID?: string
  scopeID?: string
  itemID?: string
  messageID?: string
  queued?: boolean
  itemCount?: number
  itemDeliveryKey?: string | null
  itemMetadata?: Record<string, unknown> | null
  rootMessages?: number
  queuedItems?: number
  queuedDeliveryKeys?: Array<string | null>
  materializedMessageID?: string | null
  materializedText?: string | null
  materializedInboxDeliveryKey?: string | null
  materializedChannelReplyTo?: string | null
  materializedReplyTo?: string | null
  assistantMessages?: number
  assistantErrorMessages?: number
  materializedOnce?: boolean
}

const WORKER_TIMEOUT_MS = 30_000

async function runWorker(
  fixture: string,
  home: string,
  workdir: string,
  output: string,
  phase: "enqueue" | "recover",
  packageRoot: string,
): Promise<{ report: WorkerReport; stderr: string }> {
  const child = Bun.spawn([process.execPath, "run", fixture, phase, workdir, output], {
    cwd: packageRoot,
    env: {
      ...process.env,
      SYNERGY_HOME: home,
      SYNERGY_PACKAGE_ROOT: packageRoot,
      SYNERGY_TEST_HOME: "",
      MODELS_DEV_API_JSON: "",
      SYNERGY_DISABLE_MODELS_FETCH: "true",
      SYNERGY_DISABLE_DEFAULT_PLUGINS: "true",
      SYNERGY_DISABLE_LSP_DOWNLOAD: "true",
      SYNERGY_DISABLE_FILEWATCHER: "true",
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const exitPromise = child.exited
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined
  const result = await Promise.race([
    exitPromise.then((code) => ({ code })),
    new Promise<"timeout">((resolve) => {
      timeoutHandle = setTimeout(() => resolve("timeout"), WORKER_TIMEOUT_MS)
    }),
  ])
  if (timeoutHandle) clearTimeout(timeoutHandle)
  if (result === "timeout") throw new Error(`${phase} worker timed out after ${WORKER_TIMEOUT_MS}ms`)
  const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
  if (result.code !== 0) {
    throw new Error(
      `${phase} worker exited ${result.code}\nstdout: ${stdout.trim() || "(empty)"}\nstderr: ${stderr.trim() || "(empty)"}`,
    )
  }
  const raw = await fs.readFile(output, "utf8").catch(() => "")
  return { report: JSON.parse(raw) as WorkerReport, stderr }
}

describe("fresh-process restart-while-queued recovery", () => {
  test(
    "process B startup recovery materializes the durable queued task once with metadata",
    async () => {
      const home = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-restart-queued-home-"))
      const workdir = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-restart-queued-work-"))
      const fixture = path.join(import.meta.dir, "fixtures", "restart-while-queued-worker.ts")
      const packageRoot = path.resolve(import.meta.dir, "../..")
      const outputA = path.join(workdir, "enqueue.json")
      const outputB = path.join(workdir, "recover.json")
      try {
        // Process A: a real session plus a durable queued channel task with a
        // deterministic delivery key; enqueue twice to prove dedup; exit
        // without draining the inbox.
        const a = await runWorker(fixture, home, workdir, outputA, "enqueue", packageRoot)
        expect(a.report.queued).toBe(true)
        expect(a.report.itemCount).toBe(1)
        expect(a.report.itemDeliveryKey).toBe("feishu:thread:restart-while-queued:once")
        expect(a.report.itemMetadata).toMatchObject({
          source: "channel",
          channelPush: true,
          channelReply: true,
          channelReplyToMessageId: "om_original_feishu_message",
        })
        expect(a.report.rootMessages).toBe(0)
        expect(a.report.sessionID).toBeTruthy()

        // Process B: a fresh process over the same SYNERGY_HOME whose only
        // recovery action is the startup recovery seam. No new delivery.
        const b = await runWorker(fixture, home, workdir, outputB, "recover", packageRoot)
        expect(b.report.sessionID).toBe(a.report.sessionID)

        // Target state: the queued task was discovered at startup, drained to a
        // durable materialized root exactly once, and carries its delivery and
        // channel correlation metadata forward.
        expect(b.report.queuedItems).toBe(0)
        expect(b.report.rootMessages).toBe(1)
        expect(b.report.materializedMessageID).toBeTruthy()
        expect(b.report.materializedText).toContain("process B must recover this queued channel task")
        expect(b.report.materializedInboxDeliveryKey).toBe("feishu:thread:restart-while-queued:once")
        expect(b.report.materializedChannelReplyTo).toBe("om_original_feishu_message")
        expect(b.report.materializedReplyTo).toBe("oc_thread_original_123")
        expect(b.report.assistantErrorMessages).toBe(0)
      } finally {
        await fs.rm(home, { recursive: true, force: true }).catch(() => {})
        await fs.rm(workdir, { recursive: true, force: true }).catch(() => {})
      }
    },
    { timeout: 90_000 },
  )
})
