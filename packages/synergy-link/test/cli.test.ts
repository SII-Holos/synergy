import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import process from "node:process"

const packageRoot = path.resolve(import.meta.dir, "..")

async function runCLI(args: string[], root: string) {
  const child = Bun.spawn([process.execPath, "src/cli.ts", ...args], {
    cwd: packageRoot,
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
  return { exitCode, stdout, stderr, output: stdout + stderr }
}

describe("synergy-link cli", () => {
  test("doctor renders individual checks when the command fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "synergy-link-cli-doctor-"))

    try {
      const { exitCode, output } = await runCLI(["doctor"], root)

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

  test("status reports last-known snapshots as degraded", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "synergy-link-cli-status-"))
    try {
      const result = await runCLI(["status"], root)
      expect(result.exitCode).toBe(1)
      expect(result.output).toContain("Status source")
      expect(result.output).toContain("snapshot (last-known)")
      expect(result.output).toContain("Live Synergy Link status is unavailable")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("prints the compiled version", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "synergy-link-cli-version-"))
    try {
      const result = await runCLI(["--version"], root)
      expect(result.exitCode).toBe(0)
      expect(result.stdout.trim()).toBe("0.0.0-dev")
      expect(result.stderr).toBe("")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("reconnect fails when the service cannot accept the request", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "synergy-link-cli-reconnect-"))
    try {
      const result = await runCLI(["reconnect"], root)
      expect(result.exitCode).toBe(1)
      expect(result.output).toContain("Service is not running")
      expect(result.output).not.toContain("Reconnect requested")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
