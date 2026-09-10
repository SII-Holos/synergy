import { open } from "node:fs/promises"

export function terminate(child: Bun.Subprocess, signal: NodeJS.Signals) {
  if (child.exitCode !== null) return
  try {
    if (process.platform === "win32") child.kill(signal)
    else process.kill(-child.pid, signal)
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error
  }
}

export async function runProcess(input: {
  command: string[]
  log: string
  timeoutMs: number
  env?: NodeJS.ProcessEnv
}) {
  const started_at = Date.now()
  const log = await open(input.log, "a")
  let timed_out = false
  try {
    const child = Bun.spawn(input.command, {
      env: input.env,
      stdin: "ignore",
      stdout: log.fd,
      stderr: log.fd,
      detached: true,
    })
    const deadline = setTimeout(
      () => {
        timed_out = true
        terminate(child, "SIGKILL")
      },
      Math.max(1, input.timeoutMs),
    )
    try {
      const exit_code = await child.exited
      return {
        started_at,
        ended_at: Date.now(),
        exit_code,
        signal: child.signalCode ?? null,
        timed_out,
        log: input.log,
      }
    } finally {
      clearTimeout(deadline)
    }
  } finally {
    await log.close()
  }
}
