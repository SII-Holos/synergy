import { execFile } from "node:child_process"
import { readFile } from "node:fs/promises"
import { workMap } from "../util/queue"
import { parseRssOutput, rssCommand, type ProcessSample } from "./inspection-command"

const QUERY_TIMEOUT_MS = 1000
const QUERY_CONCURRENCY = 4
const BATCH_SIZE = 128
let activeCommands = 0

export namespace ProcessInspection {
  export function alive(pid: number): boolean {
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM"
    }
  }

  export async function rssBytes(pid: number, opts: { timeoutMs?: number; signal?: AbortSignal } = {}) {
    return (await rssBatch([pid], opts)).get(pid)
  }

  export async function rssBatch(pids: number[], opts: { timeoutMs?: number; signal?: AbortSignal } = {}) {
    return new Map([...(await sampleBatch(pids, opts))].map(([pid, sample]) => [pid, sample.rssBytes]))
  }

  export async function sampleBatch(
    pids: number[],
    opts: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<Map<number, ProcessSample>> {
    const requested = [...new Set(pids)].filter((pid) => Number.isSafeInteger(pid) && pid > 0)
    const samples = new Map<number, ProcessSample>()
    if (requested.length === 0 || opts.signal?.aborted) return samples
    const controller = new AbortController()
    const cancel = () => controller.abort()
    opts.signal?.addEventListener("abort", cancel, { once: true })
    const requestedTimeout = opts.timeoutMs ?? QUERY_TIMEOUT_MS
    const timeoutMs = Number.isFinite(requestedTimeout)
      ? Math.max(1, Math.min(requestedTimeout, QUERY_TIMEOUT_MS))
      : QUERY_TIMEOUT_MS
    const timer = setTimeout(cancel, timeoutMs)
    try {
      if (process.platform === "linux") {
        await workMap(QUERY_CONCURRENCY, requested, async (pid) => {
          if (controller.signal.aborted || activeCommands >= QUERY_CONCURRENCY) return
          activeCommands++
          try {
            const read = (file: string) =>
              readFile(`/proc/${pid}/${file}`, { encoding: "utf8", signal: controller.signal })
            const before = await read("stat")
            const identity = before.slice(before.lastIndexOf(")") + 2).split(" ")[19]
            const status = await read("status")
            const after = await read("stat")
            const currentIdentity = after.slice(after.lastIndexOf(")") + 2).split(" ")[19]
            const match = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status)
            const rssBytes = match ? Number(match[1]) * 1024 : undefined
            if (
              identity &&
              identity === currentIdentity &&
              rssBytes !== undefined &&
              Number.isSafeInteger(rssBytes) &&
              rssBytes > 0
            ) {
              samples.set(pid, { rssBytes, identity })
            }
          } catch {
          } finally {
            activeCommands--
          }
        })
      } else {
        const batches: number[][] = []
        for (let offset = 0; offset < requested.length; offset += BATCH_SIZE) {
          batches.push(requested.slice(offset, offset + BATCH_SIZE))
        }
        await workMap(QUERY_CONCURRENCY, batches, async (batch) => {
          const command = rssCommand(process.platform, batch)
          if (!command || controller.signal.aborted || activeCommands >= QUERY_CONCURRENCY) return
          activeCommands++
          try {
            const stdout = await new Promise<string | undefined>((resolve) => {
              const child = execFile(
                command[0],
                command.slice(1),
                {
                  encoding: "utf8",
                  env: { ...process.env, LC_ALL: "C" },
                  maxBuffer: 256 * 1024,
                  timeout: timeoutMs,
                  killSignal: "SIGKILL",
                  windowsHide: true,
                },
                (error, stdout) => resolve(error ? undefined : stdout),
              )
              const abort = () => child.kill("SIGKILL")
              controller.signal.addEventListener("abort", abort, { once: true })
              child.once("close", () => controller.signal.removeEventListener("abort", abort))
              if (controller.signal.aborted) abort()
            })
            if (stdout === undefined || controller.signal.aborted) return
            for (const [pid, bytes] of parseRssOutput(process.platform, stdout, batch)) samples.set(pid, bytes)
          } finally {
            activeCommands--
          }
        })
      }
      if (opts.signal?.aborted) samples.clear()
      for (const pid of samples.keys()) if (!alive(pid)) samples.delete(pid)
      return samples
    } finally {
      clearTimeout(timer)
      opts.signal?.removeEventListener("abort", cancel)
    }
  }
}
