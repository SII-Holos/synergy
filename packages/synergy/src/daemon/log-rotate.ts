import fs from "fs/promises"
import path from "path"
import { DaemonPaths } from "./paths"
import { Log } from "../util/log"

const log = Log.create({ service: "log-rotate" })

export namespace DaemonLogRotate {
  const MAX_BYTES = 10 * 1024 * 1024 // 10 MB
  const MAX_ARCHIVES = 5
  const CHECK_INTERVAL = 60_000 // 1 minute

  let timer: ReturnType<typeof setInterval> | undefined

  export function start() {
    if (timer) return
    timer = setInterval(() => {
      check().catch(() => {})
    }, CHECK_INTERVAL)
    timer.unref()
  }

  export function stop() {
    if (timer) {
      clearInterval(timer)
      timer = undefined
    }
  }

  export async function check() {
    await rotateIfNeeded(DaemonPaths.logFile())
  }

  async function rotateIfNeeded(filePath: string) {
    try {
      const stat = await fs.stat(filePath).catch(() => undefined)
      if (!stat || stat.size < MAX_BYTES) return

      const timestamp = new Date().toISOString().split(".")[0].replace(/:/g, "")
      const ext = path.extname(filePath)
      const base = filePath.slice(0, -ext.length)
      const archivePath = `${base}.${timestamp}${ext}`

      await fs.rename(filePath, archivePath)
      await fs.writeFile(filePath, "", "utf8")

      log.info("rotated log", { file: path.basename(filePath), archive: path.basename(archivePath), size: stat.size })

      await cleanupArchives(filePath)
    } catch (error) {
      log.warn("log rotation failed", {
        file: filePath,
        error: error instanceof Error ? error : new Error(String(error)),
      })
    }
  }

  async function cleanupArchives(filePath: string) {
    const dir = path.dirname(filePath)
    const ext = path.extname(filePath)
    const base = path.basename(filePath, ext)
    const pattern = new RegExp(`^${escapeRegExp(base)}\\.\\d{4}-\\d{2}-\\d{2}T\\d{6}${escapeRegExp(ext)}$`)

    const entries = await fs.readdir(dir)
    const archives = entries.filter((name) => pattern.test(name)).sort()

    if (archives.length <= MAX_ARCHIVES) return

    const toDelete = archives.slice(0, archives.length - MAX_ARCHIVES)
    await Promise.all(
      toDelete.map((name) => {
        log.info("removing old log archive", { file: name })
        return fs.unlink(path.join(dir, name)).catch(() => {})
      }),
    )
  }

  function escapeRegExp(str: string) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  }

  export async function listArchives(filePath: string): Promise<{ name: string; dir: string }[]> {
    const dir = path.dirname(filePath)
    const ext = path.extname(filePath)
    const base = path.basename(filePath, ext)
    const pattern = new RegExp(`^${escapeRegExp(base)}\\.\\d{4}-\\d{2}-\\d{2}T\\d{6}${escapeRegExp(ext)}$`)

    try {
      const entries = await fs.readdir(dir)
      return entries
        .filter((name) => pattern.test(name))
        .sort()
        .reverse()
        .map((name) => ({ name, dir }))
    } catch {
      return []
    }
  }
}
