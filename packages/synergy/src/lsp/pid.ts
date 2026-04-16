import { Global } from "../global"
import { Log } from "../util/log"

export namespace LSPPid {
  const log = Log.create({ service: "lsp.pid" })
  const pidFile = Global.Path.lspPids

  export async function track(pid: number) {
    const pids = await read()
    pids.add(pid)
    await write(pids)
  }

  export async function untrack(pid: number) {
    const pids = await read()
    pids.delete(pid)
    await write(pids)
  }

  export async function cleanupOrphans() {
    const pids = await read()
    if (pids.size === 0) return
    log.info("checking for orphaned LSP processes", { count: pids.size })
    for (const pid of pids) {
      try {
        process.kill(pid, 0)
        log.info("killing orphaned LSP process", { pid })
        process.kill(pid, "SIGTERM")
        setTimeout(() => {
          try {
            process.kill(pid, "SIGKILL")
          } catch {}
        }, 1000).unref()
      } catch {}
    }
    await write(new Set())
  }

  async function read(): Promise<Set<number>> {
    try {
      const text = await Bun.file(pidFile).text()
      const arr = JSON.parse(text)
      if (Array.isArray(arr)) return new Set(arr.filter((x): x is number => typeof x === "number"))
    } catch {}
    return new Set()
  }

  async function write(pids: Set<number>) {
    await Bun.write(pidFile, JSON.stringify([...pids]))
  }
}
