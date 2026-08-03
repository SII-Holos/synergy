import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
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

async function runCLIWithStdin(args: string[], root: string, stdin: string) {
  const child = Bun.spawn([process.execPath, "src/cli.ts", ...args], {
    cwd: packageRoot,
    env: {
      ...process.env,
      SYNERGY_LINK_HOME: path.join(root, "link"),
      SYNERGY_TEST_HOME: path.join(root, "synergy"),
      NO_COLOR: "1",
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })
  const stdout = new Response(child.stdout).text()
  const stderr = new Response(child.stderr).text()
  child.stdin.write(stdin)
  child.stdin.end()

  const exitCode = await Promise.race([child.exited, Bun.sleep(3_000).then(() => undefined)])
  if (exitCode === undefined) {
    child.kill()
    await child.exited
    throw new Error("synergy-link CLI did not exit after stdin reached EOF")
  }
  const [stdoutText, stderrText] = await Promise.all([stdout, stderr])
  return { exitCode, stdout: stdoutText, stderr: stderrText, output: stdoutText + stderrText }
}

async function writeInvalidHolosConfig(root: string) {
  const configPath = path.join(root, "synergy", ".synergy", "config", "synergy.d", "100-holos.jsonc")
  await mkdir(path.dirname(configPath), { recursive: true })
  await writeFile(
    configPath,
    JSON.stringify({
      holos: { enabled: true, apiUrl: "https//invalid.example.test", wsUrl: "wss://invalid.example.test" },
    }),
  )
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

  test("promotes protected-file login and validates secret source options", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "synergy-link-cli-login-options-"))
    const secretPath = path.join(root, "agent-secret")
    try {
      await writeFile(secretPath, "candidate-secret\n", { mode: 0o600 })

      const help = await runCLI(["login", "--help"], root)
      expect(help.exitCode).toBe(0)
      expect(help.stdout).toContain("--agent-secret-file PATH")

      const missingAgent = await runCLI(["login", "--agent-secret-file", secretPath], root)
      expect(missingAgent.exitCode).toBe(1)
      expect(missingAgent.output).toContain("`--agent-id` and `--agent-secret-file` must be provided together.")

      const combined = await runCLI(
        ["login", "--agent-id", "agent_a", "--agent-secret", "candidate-secret", "--agent-secret-file", secretPath],
        root,
      )
      expect(combined.exitCode).toBe(1)
      expect(combined.output).toContain("`--agent-secret` and `--agent-secret-file` cannot be combined.")
      expect(combined.output).not.toContain("candidate-secret")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("warns when the deprecated argv secret option is used", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "synergy-link-cli-login-deprecated-"))
    try {
      await writeInvalidHolosConfig(root)
      const result = await runCLI(["login", "--agent-id", "agent_a", "--agent-secret", "candidate-secret"], root)
      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain("`--agent-secret` is deprecated")
      expect(result.output).not.toContain("candidate-secret")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("accepts a stdin secret that reaches EOF without a trailing newline", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "synergy-link-cli-login-stdin-eof-"))
    try {
      await writeInvalidHolosConfig(root)
      const result = await runCLIWithStdin(
        ["login", "--agent-id", "agent_a", "--agent-secret-file", "-"],
        root,
        "candidate-secret",
      )
      expect(result.exitCode).toBe(1)
      expect(result.output).toContain("Credential validation failed")
      expect(result.output).not.toContain("candidate-secret")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
