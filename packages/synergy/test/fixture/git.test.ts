import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { initializeGitFixture, tmpdir } from "./fixture"

describe.serial("git fixture", () => {
  test("uses one init and one commit command", async () => {
    await using tmp = await tmpdir()
    const calls: string[][] = []

    await initializeGitFixture(tmp.path, async (args) => {
      calls.push(args)
      if (args[0] === "init") {
        await fs.mkdir(path.join(tmp.path, ".git"))
        await Bun.write(path.join(tmp.path, ".git", "config"), "[core]\n\trepositoryformatversion = 0\n")
      }
      return { exitCode: 0, stderr: "" }
    })

    expect(calls).toHaveLength(2)
    expect(calls[0]).toEqual(["init"])
    expect(calls[1]?.[0]).toBe("commit")
    expect(await Bun.file(path.join(tmp.path, ".git", "config")).text()).toContain("email = test@synergy.dev")
  })

  test("retries a transient SIGPIPE exit", async () => {
    await using tmp = await tmpdir()
    let initAttempts = 0
    let commitAttempts = 0

    await initializeGitFixture(tmp.path, async (args) => {
      if (args[0] === "init") {
        initAttempts++
        if (initAttempts === 1) return { exitCode: 141, stderr: "" }
        await fs.mkdir(path.join(tmp.path, ".git"))
        await Bun.write(path.join(tmp.path, ".git", "config"), "[core]\n\trepositoryformatversion = 0\n")
      } else {
        commitAttempts++
      }
      return { exitCode: 0, stderr: "" }
    })

    expect(initAttempts).toBe(2)
    expect(commitAttempts).toBe(1)
  })

  test("reports a SIGPIPE failure after exhausting init retries", async () => {
    await using tmp = await tmpdir()
    let initAttempts = 0

    await expect(
      initializeGitFixture(tmp.path, async () => {
        initAttempts++
        return { exitCode: 141, stderr: "" }
      }),
    ).rejects.toThrow("Git fixture init failed with exit code 141: no stderr")
    expect(initAttempts).toBe(3)
  })

  test("reports a permanent initialization failure without retrying", async () => {
    await using tmp = await tmpdir()
    let attempts = 0

    await expect(
      initializeGitFixture(tmp.path, async () => {
        attempts++
        return { exitCode: 17, stderr: "fixture init exploded\n" }
      }),
    ).rejects.toThrow("Git fixture init failed with exit code 17: fixture init exploded")
    expect(attempts).toBe(1)
  })

  test("does not retry a root commit SIGPIPE failure", async () => {
    await using tmp = await tmpdir()
    let commitAttempts = 0

    await expect(
      initializeGitFixture(tmp.path, async (args) => {
        if (args[0] === "init") {
          await fs.mkdir(path.join(tmp.path, ".git"))
          await Bun.write(path.join(tmp.path, ".git", "config"), "[core]\n\trepositoryformatversion = 0\n")
          return { exitCode: 0, stderr: "" }
        }
        commitAttempts++
        return { exitCode: 141, stderr: "" }
      }),
    ).rejects.toThrow("Git fixture root commit failed with exit code 141: no stderr")
    expect(commitAttempts).toBe(1)
  })
})
