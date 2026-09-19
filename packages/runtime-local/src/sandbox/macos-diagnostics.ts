/**
 * macOS Seatbelt denial logger.
 *
 * Captures sandbox violation records from the unified log for a specific
 * sandboxed child PID. Feeds them into SandboxDetector so a structured
 * explanation can name the denied path, which the child's own error text
 * cannot always do.
 *
 * The records come from the kernel, not from `sandboxd`: a measured probe on
 * current macOS releases shows the audit line is
 *
 *   kernel[...] (Sandbox) Sandbox: <proc>(<pid>) deny(1) file-write-create <path>
 *
 * emitted by `process == "kernel"`, and that the previous
 * `process == "sandboxd" ... "deny" ... "pid=<pid>"` predicate matched nothing
 * at all. Records land a short interval after the child exits, so callers must
 * give `flush()` a bounded window instead of reading `output` at exit.
 *
 * macOS only — callers must guard with a platform check.
 */

export interface DenialLoggerSession {
  pid: number
  output: string[]
  /** Wait up to `timeoutMs` for records still in flight, then stop the stream. */
  flush: (timeoutMs?: number) => Promise<void>
  stop: () => void
}

/** Audit record for our child: `Sandbox: proc(pid) deny(N) <access> <path>`. */
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
 * Keep only denial records for `targetPid` that name a real operation.
 * Returns the normalized record line, or null when the line is noise.
 */
export function filterDenialOutput(line: string, targetPid?: number): string | null {
  const trimmed = line.trim()
  const match = DENIAL_RECORD.exec(trimmed)
  if (!match) return null

  const [, pid, access, target] = match
  if (targetPid !== undefined && Number(pid) !== targetPid) return null
  if (!access || !KEEP_ACCESS.test(access)) return null
  if (!target || BENIGN_TARGETS.has(target.trim())) return null

  return `Sandbox: ${access} ${target.trim()}`
}

function buildPredicate(): string {
  return `process == "kernel" AND eventMessage CONTAINS "Sandbox:"`
}

export function startDenialLogger(targetPid: number): DenialLoggerSession {
  const output: string[] = []
  let stopped = false

  const proc = Bun.spawn({
    cmd: ["log", "stream", "--predicate", buildPredicate(), "--style", "compact"],
    stdout: "pipe",
    stderr: "pipe",
  })

  // Read the stream in the background — never block the caller.
  const drained = (async () => {
    try {
      for await (const chunk of proc.stdout as unknown as AsyncIterable<Uint8Array>) {
        for (const line of Buffer.from(chunk).toString("utf-8").split("\n")) {
          const filtered = filterDenialOutput(line, targetPid)
          if (filtered) output.push(filtered)
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
    pid: targetPid,
    output,
    async flush(timeoutMs = 400) {
      // Records trail the child by a short interval, so a bare read returns
      // empty for a denial that did happen. Poll instead of sleeping the whole
      // window: the common case is one record arriving well inside it.
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        await Bun.sleep(40)
        if (output.length > 0) break
      }
      stop()
      await drained
    },
    stop,
  }
}
