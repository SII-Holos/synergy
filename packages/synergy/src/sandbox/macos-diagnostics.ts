/**
 * macOS Seatbelt denial logger.
 *
 * Captures sandboxd audit events via `log stream --predicate` for a specific
 * sandboxed child PID. Feeds captured denial events into SandboxDetector so
 * structured explanations include accurate path/access/networkTarget info.
 *
 * macOS only — callers must guard with a platform check.
 */

export interface DenialLoggerSession {
  pid: number
  output: string[]
  stop: () => void
}

function buildPredicate(targetPid: number): string {
  return `process == "sandboxd" AND ` + `eventMessage CONTAINS "deny" AND ` + `eventMessage CONTAINS "pid=${targetPid}"`
}

export function startDenialLogger(targetPid: number): DenialLoggerSession {
  const output: string[] = []
  const predicate = buildPredicate(targetPid)

  const proc = Bun.spawn({
    cmd: ["log", "stream", "--predicate", predicate, "--style", "compact"],
    stdout: "pipe",
    stderr: "pipe",
  })

  // Read stream in background — never block the caller
  ;(async () => {
    try {
      for await (const chunk of proc.stdout as unknown as AsyncIterable<Uint8Array>) {
        output.push(Buffer.from(chunk).toString("utf-8"))
      }
    } catch {
      // Process killed or stream closed
    }
  })()

  return {
    pid: targetPid,
    output,
    stop: () => {
      proc.kill()
    },
  }
}
