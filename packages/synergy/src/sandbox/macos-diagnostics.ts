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
const KEEP_PATTERNS = [
  /deny file-read-data/,
  /deny file-write-data/,
  /deny file-read-metadata/,
  /deny file-write-metadata/,
  /deny file-map-executable/,
  /deny network-outbound/,
  /deny network-inbound/,
  /deny process-exec/,
  /deny process-fork/,
  /deny sysctl/,
  /deny system-fsctl/,
]

const DENY_NOISE_PATTERNS = [
  /mach-lookup/,
  /file-ioctl/,
  /file-read-xattr/,
  /file-read-attrlist/,
  /\/dev\/tty/,
  /\/dev\/urandom/,
  /\/dev\/null/,
  /mDNSResponder/,
  /distnoted/,
  /com\.apple\./,
]

export function filterDenialOutput(line: string): string | null {
  const trimmed = line.trim()
  if (trimmed.length === 0) return null

  for (const p of KEEP_PATTERNS) {
    if (p.test(trimmed)) {
      for (const n of DENY_NOISE_PATTERNS) {
        if (n.test(trimmed)) return null
      }
      return trimmed
    }
  }

  return null
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
        const text = Buffer.from(chunk).toString("utf-8")
        const lines = text.split("\n")
        for (const line of lines) {
          const filtered = filterDenialOutput(line)
          if (filtered) output.push(filtered)
        }
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
