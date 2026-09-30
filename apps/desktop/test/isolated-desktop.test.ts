import { afterEach, expect, test } from "bun:test"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import path from "node:path"
import { prepareIsolatedDesktop } from "./fixture/isolated-desktop"

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

test("Desktop acceptance refuses the real home and remote application origins", async () => {
  await expect(prepareIsolatedDesktop(homedir(), "http://127.0.0.1:43198")).rejects.toThrow("isolated home")
  await expect(prepareIsolatedDesktop(tmpdir(), "https://example.com")).rejects.toThrow("loopback HTTP")
})

test("isolated Desktop artifacts stay under the selected home and keep userData across restarts", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "synergy-desktop-acceptance-"))
  directories.push(home)
  const first = await prepareIsolatedDesktop(home, "http://127.0.0.1:43198")
  const second = await prepareIsolatedDesktop(home, "http://127.0.0.1:43198")
  expect(first.userData).toBe(second.userData)
  expect(first.home).toBe(await realpath(home))
  expect(path.relative(first.home, first.userData).startsWith("..")).toBe(false)
  expect(await Bun.file(first.wrapper).exists()).toBe(true)
  expect(first.appURL).toBe("http://127.0.0.1:43198/")
})
