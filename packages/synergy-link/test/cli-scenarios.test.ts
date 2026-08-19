import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import process from "node:process"

const packageRoot = path.resolve(import.meta.dir, "..")
const originalHome = process.env.SYNERGY_LINK_HOME
const originalSynergyHome = process.env.SYNERGY_TEST_HOME
const tempRoots: string[] = []

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

async function runJson(args: string[], root: string) {
  const result = await runCLI(["--json", ...args], root)
  const payload = JSON.parse(result.stdout) as { ok: boolean; error?: { message?: string; usage?: string } }
  return { ...result, payload }
}

async function createRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), "synergy-link-cli-scenarios-"))
  tempRoots.push(root)
  return root
}

afterEach(async () => {
  if (originalHome === undefined) delete process.env.SYNERGY_LINK_HOME
  else process.env.SYNERGY_LINK_HOME = originalHome
  if (originalSynergyHome === undefined) delete process.env.SYNERGY_TEST_HOME
  else process.env.SYNERGY_TEST_HOME = originalSynergyHome
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("synergy-link cli offline scenarios", () => {
  test("renders root help for bare and -h invocations", async () => {
    const root = await createRoot()
    const bare = await runCLI([], root)
    expect(bare.exitCode).toBe(0)
    expect(bare.stdout).toContain("Usage: synergy-link <command> [options]")
    expect(bare.stdout).toContain("start | stop | restart")
    expect(bare.stdout).toContain("requests <list|show|approve|deny> [request-id]")

    const flagged = await runCLI(["--help"], root)
    expect(flagged.exitCode).toBe(0)
    expect(flagged.stdout).toContain("Usage: synergy-link <command> [options]")
  })

  test("renders per-command usage for known commands and falls back to root usage", async () => {
    const root = await createRoot()
    const logs = await runCLI(["logs", "--help"], root)
    expect(logs.stdout).toContain("Usage: synergy-link logs [-f] [--tail N] [--since DURATION]")

    const login = await runCLI(["login", "--help"], root)
    expect(login.stdout).toContain("--agent-secret-file -")
    expect(login.stdout).toContain("deprecated")

    const start = await runCLI(["start", "--help"], root)
    expect(start.stdout).toContain("Usage: synergy-link start")

    const subcommand = await runCLI(["mode", "status", "--help"], root)
    expect(subcommand.stdout).toContain("Usage: synergy-link mode <status|managed|standalone>")
  })

  test("rejects unknown commands and unknown options with exit 1", async () => {
    const root = await createRoot()
    const unknown = await runCLI(["frobnicate"], root)
    expect(unknown.exitCode).toBe(1)
    expect(unknown.output).toContain("Unknown command: frobnicate")
    expect(unknown.output).toContain("Usage: synergy-link <command> [options]")

    const option = await runCLI(["--bogus"], root)
    expect(option.exitCode).toBe(1)
    expect(option.output).toContain("Unknown option: --bogus")
  })

  test("prints the compiled version for --version and -v", async () => {
    const root = await createRoot()
    expect((await runCLI(["--version"], root)).stdout.trim()).toBe("0.0.0-dev")
    expect((await runCLI(["-v"], root)).stdout.trim()).toBe("0.0.0-dev")
  })

  test("rejects json for server and for follow logs", async () => {
    const root = await createRoot()
    const server = await runJson(["server"], root)
    expect(server.exitCode).toBe(1)
    expect(server.payload).toMatchObject({
      ok: false,
      error: { message: "`--json` is not supported for `server`." },
    })

    const follow = await runJson(["logs", "-f"], root)
    expect(follow.exitCode).toBe(1)
    expect(follow.payload).toMatchObject({
      ok: false,
      error: { message: "`--json` is not supported with `logs -f`." },
    })
  })

  test("rejects extra arguments for single-arg commands", async () => {
    const root = await createRoot()
    for (const command of ["stop", "restart", "status", "logout", "whoami", "reconnect", "doctor", "start"]) {
      const result = await runJson([command, "extra"], root)
      expect(result.exitCode).toBe(1)
      expect(result.payload.ok).toBe(false)
      expect(result.payload.error?.usage).toContain(`Usage: synergy-link ${command}`)
    }
    const server = await runJson(["server", "extra"], root)
    expect(server.exitCode).toBe(1)
    expect(server.payload.error?.usage).toContain("Usage: synergy-link server [--print-logs]")
  })

  test("validates login option combinations without touching credentials", async () => {
    const root = await createRoot()
    const secretPath = path.join(root, "secret")
    await writeFile(secretPath, "candidate\n", { mode: 0o600 })

    const missing = await runJson(["login", "--agent-secret-file", secretPath], root)
    expect(missing.exitCode).toBe(1)
    expect(missing.payload.error?.message).toContain("must be provided together")

    const combined = await runJson(
      ["login", "--agent-id", "agent_a", "--agent-secret", "candidate", "--agent-secret-file", secretPath],
      root,
    )
    expect(combined.exitCode).toBe(1)
    expect(combined.payload.error?.message).toContain("cannot be combined")

    const missingFileValue = await runJson(["login", "--agent-secret-file"], root)
    expect(missingFileValue.exitCode).toBe(1)
    expect(missingFileValue.payload.error?.usage).toContain("Usage: synergy-link login")

    const bareAgent = await runJson(["login", "--agent-id", "agent_a"], root)
    expect(bareAgent.exitCode).toBe(1)
    expect(bareAgent.payload.error?.message).toContain("requires `--agent-secret-file`")
  })

  test("validates mode/collaboration/session/approval/trust/label usage offline", async () => {
    const root = await createRoot()

    for (const command of [
      ["mode"],
      ["collaboration"],
      ["requests"],
      ["session"],
      ["approval"],
      ["trust"],
      ["label"],
    ]) {
      const result = await runJson(command, root)
      expect(result.exitCode).toBe(1)
      expect(result.payload.ok).toBe(false)
      expect(result.payload.error?.usage).toContain("Usage: synergy-link")
    }

    const modeExtra = await runJson(["mode", "status", "extra"], root)
    expect(modeExtra.exitCode).toBe(1)
    expect(modeExtra.payload.error?.usage).toContain("Usage: synergy-link mode <status|managed|standalone>")

    const modeUnknown = await runJson(["mode", "banana"], root)
    expect(modeUnknown.exitCode).toBe(1)

    const requestsBad = await runJson(["requests", "show"], root)
    expect(requestsBad.exitCode).toBe(1)
    expect(requestsBad.payload.error?.usage).toContain("Usage: synergy-link requests")

    const sessionExtra = await runJson(["session", "status", "extra"], root)
    expect(sessionExtra.exitCode).toBe(1)

    const approvalBad = await runJson(["approval", "set", "banana"], root)
    expect(approvalBad.exitCode).toBe(1)

    const trustBad = await runJson(["trust", "add", "robot", "agent_a"], root)
    expect(trustBad.exitCode).toBe(1)

    const labelEmpty = await runJson(["label", "set", "   "], root)
    expect(labelEmpty.exitCode).toBe(1)
    expect(labelEmpty.payload.error?.usage).toContain("Usage: synergy-link label set <label>")
  })

  test("validates logs option parsing", async () => {
    const root = await createRoot()
    expect((await runCLI(["logs", "--tail", "zero"], root)).exitCode).toBe(1)
    expect((await runCLI(["logs", "--tail", "0"], root)).exitCode).toBe(1)
    expect((await runCLI(["logs", "--since"], root)).exitCode).toBe(1)
    expect((await runCLI(["logs", "--bogus"], root)).exitCode).toBe(1)
  })

  test("renders offline status in human output", async () => {
    const root = await createRoot()
    const session = await runCLI(["session", "status"], root)
    expect(session.exitCode).toBe(0)
    expect(session.stdout).toContain("idle")

    const approval = await runCLI(["approval", "get"], root)
    expect(approval.exitCode).toBe(0)
    expect(approval.stdout).toContain("manual")

    const trust = await runCLI(["trust", "list"], root)
    expect(trust.exitCode).toBe(0)
    expect(trust.stdout).toContain("Trusted agents")

    const requests = await runCLI(["requests", "list"], root)
    expect(requests.exitCode).toBe(0)
    expect(requests.stdout).toContain("No requests")

    const collaboration = await runCLI(["collaboration", "status"], root)
    expect(collaboration.exitCode).toBe(0)
    expect(collaboration.stdout).toContain("Enabled")

    const whoami = await runCLI(["whoami"], root)
    expect(whoami.exitCode).toBe(0)
    expect(whoami.stdout).toContain("Logged in")
  })

  test("applies offline collaboration, mode, trust, and label writes", async () => {
    const root = await createRoot()

    const enable = await runJson(["collaboration", "enable"], root)
    expect(enable.exitCode).toBe(0)
    expect(enable.payload).toMatchObject({ ok: true, data: { enabled: true } })

    const disable = await runJson(["collaboration", "disable"], root)
    expect(disable.exitCode).toBe(0)
    expect(disable.payload).toMatchObject({ ok: true, data: { enabled: false } })

    const managed = await runJson(["mode", "managed"], root)
    expect(managed.exitCode).toBe(0)
    expect(managed.payload).toMatchObject({ ok: true, data: { mode: "managed" } })

    const standalone = await runJson(["mode", "standalone"], root)
    expect(standalone.exitCode).toBe(0)
    expect(standalone.payload).toMatchObject({ ok: true, data: { mode: "standalone" } })

    const addTrust = await runJson(["trust", "add", "agent", "agent_a"], root)
    expect(addTrust.exitCode).toBe(0)
    expect(addTrust.payload).toMatchObject({ ok: true, data: { agents: ["agent_a"] } })

    const addUser = await runJson(["trust", "add", "user", "42"], root)
    expect(addUser.exitCode).toBe(0)
    expect(addUser.payload).toMatchObject({ ok: true, data: { users: [42] } })

    const removeTrust = await runJson(["trust", "remove", "agent", "agent_a"], root)
    expect(removeTrust.exitCode).toBe(0)
    expect(removeTrust.payload).toMatchObject({ ok: true, data: { agents: [] } })

    const badUser = await runJson(["trust", "add", "user", "not-a-number"], root)
    expect(badUser.exitCode).toBe(1)
    expect(badUser.payload.ok).toBe(false)

    const setLabel = await runJson(["label", "set", "test host"], root)
    expect(setLabel.exitCode).toBe(0)
    expect(setLabel.payload).toMatchObject({ ok: true, data: { label: "test host" } })

    const clearLabel = await runJson(["label", "clear"], root)
    expect(clearLabel.exitCode).toBe(0)
    expect(clearLabel.payload).toMatchObject({ ok: true, data: { label: null } })

    const approval = await runJson(["approval", "set", "auto"], root)
    expect(approval.exitCode).toBe(0)
    expect(approval.payload).toMatchObject({ ok: true, data: { mode: "auto" } })

    const kick = await runJson(["session", "kick"], root)
    expect(kick.exitCode).toBe(0)
    expect(kick.payload).toMatchObject({ ok: true, data: { requested: false } })

    const block = await runJson(["block"], root)
    expect(block.exitCode).toBe(0)
    expect(block.payload).toMatchObject({ ok: true, data: { requested: false, block: true } })

    const approveUnknown = await runJson(["requests", "approve", "unknown"], root)
    expect(approveUnknown.exitCode).toBe(1)
    expect(approveUnknown.payload.ok).toBe(false)

    const showUnknown = await runJson(["requests", "show", "unknown"], root)
    expect(showUnknown.exitCode).toBe(1)
    expect(showUnknown.payload.ok).toBe(false)

    const denyUnknown = await runJson(["requests", "deny", "unknown"], root)
    expect(denyUnknown.exitCode).toBe(1)
    expect(denyUnknown.payload.ok).toBe(false)
  })

  test("renders offline stop/status/logs/reconnect with machine-readable data", async () => {
    const root = await createRoot()
    const stop = await runJson(["stop"], root)
    expect(stop.exitCode).toBe(0)
    expect(stop.payload).toMatchObject({ ok: true })

    const status = await runJson(["status"], root)
    expect(status.exitCode).toBe(1)
    expect(status.payload.ok).toBe(false)
    expect(status.payload.error?.message).toContain("Live Synergy Link status is unavailable")

    const logs = await runJson(["logs", "--tail", "5", "--since", "1h"], root)
    expect(logs.exitCode).toBe(0)
    expect(logs.payload).toMatchObject({ ok: true, data: { content: "" } })

    const reconnect = await runJson(["reconnect"], root)
    expect(reconnect.exitCode).toBe(1)
    expect(reconnect.payload.ok).toBe(false)
  })

  test("start reports failure when the service child cannot serve a control plane", async () => {
    const root = await createRoot()
    await mkdir(path.join(root, "link", "control.sock"), { recursive: true })

    const start = await runJson(["start"], root)
    expect(start.exitCode).toBe(1)
    expect(start.payload).toMatchObject({
      ok: false,
      error: { message: "Synergy Link service failed to start." },
    })
  })

  test("restart reports failure when the service child cannot serve a control plane", async () => {
    const root = await createRoot()
    await mkdir(path.join(root, "link", "control.sock"), { recursive: true })

    const restart = await runJson(["restart"], root)
    expect(restart.exitCode).toBe(1)
    expect(restart.payload).toMatchObject({
      ok: false,
      error: { message: "Synergy Link service failed to restart." },
    })
  })

  test("renders doctor failures and json doctor payloads", async () => {
    const root = await createRoot()
    const doctor = await runJson(["doctor"], root)
    expect(doctor.exitCode).toBe(1)
    expect(doctor.payload.ok).toBe(false)
    expect(doctor.payload.error?.message).toContain("Synergy Link checks found issues")
  })
})
