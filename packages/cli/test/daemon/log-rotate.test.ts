import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { DaemonPaths } from "@ericsanchezok/synergy-harness/util/daemon-paths"
import { DaemonLogRotate } from "../../src/daemon/log-rotate"

test("daemon log rotation retains the newest five archives and starts a fresh log", async () => {
  const file = DaemonPaths.logFile()
  const dir = path.dirname(file)
  await fs.mkdir(dir, { recursive: true })
  const base = path.basename(file, path.extname(file))
  for (let day = 1; day <= 6; day++) await Bun.write(path.join(dir, `${base}.2000-01-0${day}T000000.log`), "archive")
  await Bun.write(path.join(dir, "unrelated.log"), "leave me")
  await Bun.write(file, Buffer.alloc(10 * 1024 * 1024, 65))
  DaemonLogRotate.start()
  DaemonLogRotate.start()
  try {
    await DaemonLogRotate.check()
    expect(Bun.file(file).size).toBe(0)
    const archives = await DaemonLogRotate.listArchives(file)
    expect(archives).toHaveLength(5)
    expect(archives.some((item) => item.name.includes("2000-01-01"))).toBe(false)
    expect(archives.some((item) => item.name.includes("2000-01-02"))).toBe(false)
    expect(await Bun.file(path.join(dir, "unrelated.log")).text()).toBe("leave me")
    expect(await Bun.file(path.join(dir, archives[0].name)).size).toBe(10 * 1024 * 1024)
    await DaemonLogRotate.check()
    expect(await DaemonLogRotate.listArchives(file)).toHaveLength(5)
    expect(await DaemonLogRotate.listArchives(path.join(dir, "missing/file.log"))).toEqual([])
  } finally {
    DaemonLogRotate.stop()
    DaemonLogRotate.stop()
    await fs.rm(file, { force: true })
    for (const archive of await DaemonLogRotate.listArchives(file))
      await fs.rm(path.join(dir, archive.name), { force: true })
    await fs.rm(path.join(dir, "unrelated.log"), { force: true })
  }
})
