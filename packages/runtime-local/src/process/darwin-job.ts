import fs from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"

export namespace DarwinJob {
  async function launchctl(args: string[]) {
    const child = Bun.spawn(["/bin/launchctl", ...args], { stdout: "ignore", stderr: "pipe" })
    const [code, error] = await Promise.all([child.exited, new Response(child.stderr).text()])
    return { code, error: error.trim() }
  }
  const xml = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  export async function releaseDisconnectedWorker(directory: string) {
    const target = process.env.SYNERGY_OWNED_PROCESS_JOB
    if (!target || !/^(gui|user)\/[0-9]+\/com\.synergy\.process\.[a-f0-9-]{36}$/.test(target))
      throw new Error("Native process job identity is unavailable")
    if (target.split("/")[1] !== String(process.getuid?.()))
      throw new Error("Native process job belongs to another user")
    const stat = await fs.lstat(directory)
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o077) !== 0 ||
      !path.basename(directory).startsWith("sy-p-")
    )
      throw new Error("Native process cleanup directory is not owned")
    for (const name of ["input.json", "job.plist", "startup.log", "io"])
      await fs.unlink(path.join(directory, name)).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error
      })
    await fs.rmdir(directory)
    await launchctl(["bootout", target])
  }
  export async function start(args: string[], directory: string) {
    const uid = process.getuid?.()
    if (uid === undefined) throw new Error("Native process ownership requires a macOS user session")
    const gui = `gui/${uid}`
    const domain = (await launchctl(["print", gui])).code === 0 ? gui : `user/${uid}`
    const label = `com.synergy.process.${randomUUID()}`
    const filename = path.join(directory, "job.plist")
    await fs.writeFile(
      filename,
      `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array>${args.map((arg) => `<string>${xml(arg)}</string>`).join("")}</array><key>EnvironmentVariables</key><dict><key>SYNERGY_OWNED_PROCESS_JOB</key><string>${domain}/${label}</string></dict><key>RunAtLoad</key><true/><key>AbandonProcessGroup</key><true/><key>StandardOutPath</key><string>/dev/null</string><key>StandardErrorPath</key><string>${xml(path.join(directory, "startup.log"))}</string></dict></plist>`,
      { mode: 0o600 },
    )
    const result = await launchctl(["bootstrap", domain, filename])
    if (result.code !== 0) throw new Error(`Native process ownership is unavailable: ${result.error}`)
    let removed = false
    return {
      async remove() {
        if (removed) return
        const result = await launchctl(["bootout", `${domain}/${label}`])
        if (result.code !== 0 && (await launchctl(["print", `${domain}/${label}`])).code === 0)
          throw new Error(`Native process cleanup failed: ${result.error}`)
        removed = true
      },
    }
  }
}
