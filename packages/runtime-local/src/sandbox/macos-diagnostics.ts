/**
 * macOS Seatbelt denial logger.
 *
 * Captures sandbox violation records from the unified log for a sandboxed
 * child. Feeds them into SandboxDetector so a structured explanation can name
 * the denied path *and* the access, which the child's own error text cannot.
 *
 * The records come from the kernel, not from `sandboxd`: a measured probe on
 * current macOS releases shows the audit line is
 *
 *   kernel[...] (Sandbox) Sandbox: <proc>(<pid>) deny(1) file-write-create <path>
 *
 * emitted by `process == "kernel"`, and that the previous
 * `process == "sandboxd" ... "deny" ... "pid=<pid>"` predicate matched nothing
 * at all.
 *
 * Two timing facts shape this module:
 *
 * - The stream must already be running when the denial is emitted. A record is
 *   produced within microseconds of the child's failing syscall, so a logger
 *   started after `spawn` loses the race for a fast command. The session is
 *   therefore started before the child and bound to its pid afterwards, which
 *   is why `startDenialLogger` takes no pid and `adoptPid` exists.
 * - Records land a short interval after the event, so callers must `flush()`
 *   for a bounded window instead of reading `output` at child close.
 *
 * macOS only — callers must guard with a platform check.
 */

export interface DenialLoggerSession {
  /** Set once the child exists; records for other pids are held back until then. */
  readonly pid: number | undefined
  /** Denial records for the adopted pid, in arrival order. */
  readonly output: string[]
  /** Bind the session to the child pid and release its held-back records. */
  adoptPid(pid: number): void
  /** Wait up to `timeoutMs` for records still in flight, then stop the stream. */
  flush: (timeoutMs?: number) => Promise<void>
  stop: () => void
}

/** Audit record for a sandboxed process: `Sandbox: proc(pid) deny(N) <access> <path>`. */
const DENIAL_RECORD = /Sandbox: \S+\((\d+)\) deny\(\d+\) (\S+) (.*)$/

/**
 * Access families worth reporting. `mach-lookup`, `file-ioctl`, and the other
 * noise families are excluded because every sandboxed process emits them and
 * none is the operation the caller asked for.
 */
const KEEP_ACCESS = /^(file-read|file-write|network-|process-exec|process-fork)/

/**
 * Devices every sandboxed child is denied. Reporting them would make every
 * command look blocked.
 */
const BENIGN_TARGETS = new Set(["/dev/tty", "/dev/null", "/dev/stdout", "/dev/stderr", "/dev/urandom"])

/**
 * Keep a denial record that names a real operation, dropping noise.
 *
 * Returns the original record unchanged: the detector owns parsing the kernel
 * shape, and rewriting it into a shorter form silently drops the access, which
 * is the one field that makes the denial approvable.
 */
export function filterDenialOutput(line: string): string | null {
  const trimmed = line.trim()
  const match = DENIAL_RECORD.exec(trimmed)
  if (!match) return null

  const [, , access, target] = match
  if (!access || !KEEP_ACCESS.test(access)) return null
  if (!target || BENIGN_TARGETS.has(target.trim())) return null

  return trimmed
}

/** Pid a normalized record belongs to, or undefined when unparseable. */
function recordPid(record: string): number | undefined {
  const match = DENIAL_RECORD.exec(record)
  return match ? Number(match[1]) : undefined
}

function buildPredicate(): string {
  return `process == "kernel" AND eventMessage CONTAINS "Sandbox:"`
}

export function startDenialLogger(): DenialLoggerSession {
  // Records that name a real operation, for any pid: the pid is not known until
  // after the child exists, and the stream has to be live before then.
  const candidates: string[] = []
  const output: string[] = []
  let targetPid: number | undefined

  const select = () => {
    output.length = 0
    for (const record of candidates) {
      if (targetPid === undefined || recordPid(record) === targetPid) output.push(record)
    }
  }

  const proc = Bun.spawn({
    cmd: ["log", "stream", "--predicate", buildPredicate(), "--style", "compact"],
    stdout: "pipe",
    stderr: "pipe",
  })
  let stopped = false

  // Read the stream in the background — never block the caller.
  const drained = (async () => {
    try {
      for await (const chunk of proc.stdout as unknown as AsyncIterable<Uint8Array>) {
        for (const line of Buffer.from(chunk).toString("utf-8").split("\n")) {
          const filtered = filterDenialOutput(line)
          if (!filtered) continue
          candidates.push(filtered)
          if (targetPid !== undefined) select()
        }
      }
    } catch {
      // Process killed or stream closed
    }
  })()

  const stop = () => {
    if (stopped) return
    stopped = true
    proc.kill()
  }

  return {
    get pid() {
      return targetPid
    },
    output,
    adoptPid(pid: number) {
      targetPid = pid
      select()
    },
    async flush(timeoutMs = 400) {
      // Records trail the event, so a bare read returns empty for a denial that
      // did happen. Poll instead of sleeping the whole window: the common case
      // is one record arriving well inside it.
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        await Bun.sleep(40)
        if (targetPid !== undefined && output.length > 0) break
      }
      select()
      stop()
      await drained
    },
    stop,
  }
}
