import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import process from "node:process"

describe("synergy-link cli", () => {
  test("doctor renders individual checks when the command fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "synergy-link-cli-doctor-"))

    try {
      const child = Bun.spawn([process.execPath, "src/cli.ts", "doctor"], {
        cwd: path.resolve(import.meta.dir, ".."),
        env: {
          ...process.env,
          SYNERGY_LINK_HOME: path.join(root, "link"),
          SYNERGY_TEST_HOME: path.join(root, "synergy"),
          NO_COLOR: "1",
        },
        stdout: "pipe",
        stderr: "pipe",
      })
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      const output = stdout + stderr

      expect(exitCode).toBe(1)
      expect(output).toContain("✔ config_dir —")
      expect(output).toContain("✘ auth — No Holos credentials found")
      expect(output).toContain("✘ service — Service is not running")
      expect(output).toContain("✘ Issues found")
      expect(output).toContain("Synergy Link checks found issues.")
      expect(output).not.toContain("Logged in")
      expect(output).not.toContain("Pending requests")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
