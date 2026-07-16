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

  test("reports the failed initialization stage with exit details", async () => {
    await using tmp = await tmpdir()

    await expect(
      initializeGitFixture(tmp.path, async () => ({ exitCode: 17, stderr: "fixture init exploded\n" })),
    ).rejects.toThrow("Git fixture init failed with exit code 17: fixture init exploded")
  })
})
