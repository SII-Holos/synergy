import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { configureDesktopUserData } from "../src/user-data"

test("an explicit Desktop directory is configured before the app requests its lock", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "synergy-desktop-user-data-"))
  const calls: unknown[] = []
  try {
    configureDesktopUserData(
      {
        setPath: (...args) => {
          calls.push(args)
        },
      },
      { SYNERGY_DESKTOP_USER_DATA_DIR: directory },
    )
    expect(calls).toEqual([["userData", directory]])
    configureDesktopUserData(
      {
        setPath: (...args) => {
          calls.push(args)
        },
      },
      {},
    )
    expect(calls).toHaveLength(1)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
