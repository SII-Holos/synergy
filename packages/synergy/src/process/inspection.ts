import { readFileSync } from "node:fs"

export namespace ProcessInspection {
  export function alive(pid: number): boolean {
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM"
    }
  }

  export function rssBytes(pid: number): number | undefined {
    try {
      if (process.platform === "linux") {
        const status = readFileSync(`/proc/${pid}/status`, "utf8")
        const match = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status)
        return match ? Number(match[1]) * 1024 : undefined
      }
      if (process.platform === "darwin") {
        const result = Bun.spawnSync({ cmd: ["ps", "-o", "rss=", "-p", String(pid)], stdout: "pipe" })
        const rssKb = Number(result.stdout.toString().trim())
        return Number.isFinite(rssKb) && rssKb > 0 ? rssKb * 1024 : undefined
      }
      if (process.platform === "win32") {
        const result = Bun.spawnSync({
          cmd: [
            "powershell.exe",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            `(Get-Process -Id ${pid} -ErrorAction Stop).WorkingSet64`,
          ],
          stdout: "pipe",
          stderr: "ignore",
        })
        const bytes = Number(result.stdout.toString().trim())
        return Number.isFinite(bytes) && bytes > 0 ? bytes : undefined
      }
    } catch {}
  }
}
