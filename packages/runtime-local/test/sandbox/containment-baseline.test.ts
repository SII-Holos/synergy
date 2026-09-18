// ---------------------------------------------------------------------------
// sandbox/containment-baseline.test.ts
//
// Objective containment facts for the real OS sandbox on this host. Every fact
// below runs a REAL command through the canonical wrapper entry point
// (SandboxBackend.prepareWrapper + SandboxBackend.executeAsync) rather than
// asserting on generated policy text, so a later phase can decide from
// observable evidence which static-analysis protections are redundant.
//
// Attribution rule: a target the host already denies (e.g. /etc is owned by
// root, a credential file does not exist) proves nothing about the sandbox.
// Each external-write and credential probe therefore records a host-side
// baseline first, and the tests additionally assert the baseline was
// permissive, so a "blocked" observation is attributable to the sandbox.
//
// Facts are asserted in their DESIRED polarity (the sandbox should contain the
// command), including the firmlink-alias probe at the end of this file: a
// protected subpath must stay read-only no matter which spelling of the
// workspace path the sandboxed command addresses.
//
// Run with:
//   cd packages/runtime-local && bun test test/sandbox/containment-baseline.test.ts
// ---------------------------------------------------------------------------

import { describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { SandboxBackend } from "../../src/sandbox/backend"
import { DEFAULT_SYSTEM_RUNTIME_READ_ROOTS, controlledTempRoot } from "@ericsanchezok/synergy-harness/sandbox/policy"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"

interface Availability {
  available: boolean
  reason: string
}

function detectAvailability(): Availability {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    return { available: false, reason: `no OS sandbox backend on ${process.platform}` }
  }
  const info = SandboxBackend.platformInfo()
  if (!info.available) {
    return {
      available: false,
      reason: `${info.platform} sandbox backend unavailable (${info.backend ?? "no backend"})`,
    }
  }
  if (process.platform === "darwin" && !fs.existsSync("/usr/bin/sandbox-exec")) {
    return { available: false, reason: "/usr/bin/sandbox-exec is not installed" }
  }
  if (process.platform === "linux") {
    const probe = Bun.spawnSync({
      cmd: ["bwrap", "--dev-bind", "/", "/", "/bin/true"],
      stdout: "pipe",
      stderr: "pipe",
    })
    if (probe.exitCode !== 0) {
      return { available: false, reason: "bwrap cannot create a sandbox on this host (user namespaces unavailable)" }
    }
  }
  const workspace = process.env["SYNERGY_TEST_ROOT"] ?? os.tmpdir()
  const wrapper = SandboxBackend.prepareWrapper({
    command: "/bin/sh",
    args: ["-c", "true"],
    workspace,
    sandboxMode: "workspace_write",
    networkMode: "restricted",
  })
  if (wrapper.tempPath) SandboxBackend.cleanupTemp(wrapper.tempPath)
  if (wrapper.skipReason) return { available: false, reason: wrapper.skipReason }
  if (!wrapper.sandboxed) return { available: false, reason: "prepareWrapper returned an unwrapped command" }
  return { available: true, reason: `${info.backend ?? info.platform} active` }
}

const availability = detectAvailability()

// CI installs bwrap, the AppArmor userns profile, and the helper, so a silent
// skip there would hide a broken sandbox behind a green build. Mirrors the
// convention in linux-readable-roots.test.ts.
if (!availability.available) {
  if (process.env["SYNERGY_TEST_LINUX_SANDBOX_E2E"] === "1") {
    throw new Error(`SYNERGY_TEST_LINUX_SANDBOX_E2E=1 but the real OS sandbox is unavailable: ${availability.reason}`)
  }
  console.log(`[containment-baseline] real-sandbox facts skipped: ${availability.reason}`)
}

// macOS /var/folders and /tmp are firmlinked to /private/...; the profile
// compiler canonicalizes some paths and not others, which is the precondition
// for the escape recorded at the end of this file.
const FIRMLINKED_TMP = process.platform === "darwin" && fs.realpathSync(os.tmpdir()) !== os.tmpdir()

interface ProbeResult {
  exitCode: number
  stdout: string
  stderr: string
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * Run a real command through the canonical sandbox wrapper. Commands are
 * written to exit 0 and report their outcome through a sentinel, because
 * executeAsync converts a failed command whose output matches a denial
 * pattern into a thrown SandboxBlocked.
 */
async function runInSandbox(workspace: string, command: string, env?: Record<string, string>): Promise<ProbeResult> {
  const wrapper = SandboxBackend.prepareWrapper({
    command: "/bin/sh",
    args: ["-c", command],
    workspace,
    sandboxMode: "workspace_write",
    networkMode: "restricted",
  })
  try {
    const result = await SandboxBackend.executeAsync(wrapper, {
      fallbackPolicy: "deny",
      cwd: workspace,
      env,
      timeoutMs: 30_000,
    })
    return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr }
  } finally {
    if (wrapper.tempPath) SandboxBackend.cleanupTemp(wrapper.tempPath)
  }
}

/** Whether the host user could create a file at `target` without the sandbox. */
function hostWriteBaseline(target: string): boolean {
  try {
    fs.accessSync(path.dirname(target), fs.constants.W_OK)
    return true
  } catch {
    return false
  }
}

function probeId(): string {
  return `${process.pid}-${Math.random().toString(36).slice(2, 10)}`
}

async function writeProbe(workspace: string, target: string) {
  const result = await runInSandbox(workspace, `echo probe > ${shellQuote(target)} && echo WROTE || echo BLOCKED`)
  return {
    wrote: result.stdout.includes("WROTE"),
    blocked: result.stdout.includes("BLOCKED"),
    hostFileExists: fs.existsSync(target),
    stderr: result.stderr.trim(),
  }
}

async function readProbe(workspace: string, target: string) {
  const result = await runInSandbox(
    workspace,
    `if cat ${shellQuote(target)} >/dev/null 2>&1; then echo LEAKED; else echo NOT_READABLE; fi`,
  )
  return { readable: result.stdout.includes("LEAKED"), stdout: result.stdout, stderr: result.stderr.trim() }
}

describe.skipIf(!availability.available)("OS sandbox containment baseline", () => {
  test("external write targets stay unwritable", async () => {
    await using fixture = await tmpdir()
    const id = probeId()
    const targets: Record<string, string> = {
      "system /etc": `/etc/harness-baseline-probe-${id}`,
      "user home": path.join(os.homedir(), `.harness-baseline-probe-${id}`),
      "shared temp": `/tmp/harness-baseline-probe-${id}`,
    }
    const recorded: Record<string, { blocked: boolean; wrote: boolean; hostFileExists: boolean }> = {}
    try {
      for (const [label, target] of Object.entries(targets)) {
        const result = await writeProbe(fixture.path, target)
        recorded[label] = {
          blocked: result.blocked,
          wrote: result.wrote,
          hostFileExists: result.hostFileExists,
        }
      }
      expect(recorded).toEqual({
        "system /etc": { blocked: true, wrote: false, hostFileExists: false },
        "user home": { blocked: true, wrote: false, hostFileExists: false },
        "shared temp": { blocked: true, wrote: false, hostFileExists: false },
      })
      // The home and shared-temp targets are writable by this user outside the
      // sandbox, so those two blocks are attributable to the sandbox rather
      // than to host ownership of the parent directory.
      expect(hostWriteBaseline(targets["user home"]!)).toBe(true)
      expect(hostWriteBaseline(targets["shared temp"]!)).toBe(true)
      console.log(`[containment-baseline] external writes blocked: ${JSON.stringify(recorded)}`)
    } finally {
      for (const target of Object.values(targets)) fs.rmSync(target, { force: true })
    }
  })

  test("credential paths stay unreadable", async () => {
    const testHome = process.env["SYNERGY_TEST_HOME"]
    if (!testHome) throw new Error("SYNERGY_TEST_HOME is not set; the test preload is not active")
    await using fixture = await tmpdir()

    const marker = `SYNERGY-CONTAINMENT-MARKER-${probeId()}`
    const synthetic = {
      "ssh private key": path.join(testHome, ".ssh", "id_rsa"),
      "aws credentials": path.join(testHome, ".aws", "credentials"),
    }
    for (const [index, target] of Object.values(synthetic).entries()) {
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, `${marker}-${index}\n`)
    }

    const recorded: Record<string, { readable: boolean; hostFileExists: boolean }> = {}
    const outputs: string[] = []
    try {
      for (const [label, target] of Object.entries(synthetic)) {
        // Host baseline: the isolated test home is fully readable outside the
        // sandbox, so a denial inside it is attributable to the sandbox.
        expect(fs.readFileSync(target, "utf8")).toContain(marker)
        const result = await readProbe(fixture.path, target)
        outputs.push(result.stdout, result.stderr)
        recorded[label] = { readable: result.readable, hostFileExists: fs.existsSync(target) }
      }
      expect(recorded).toEqual({
        "ssh private key": { readable: false, hostFileExists: true },
        "aws credentials": { readable: false, hostFileExists: true },
      })
      // Defense in depth: no channel of the run exposed the credential body.
      expect(outputs.join("\n")).not.toContain(marker)

      // Real-home credential stores. Probed only when present so a missing
      // directory is never mistaken for a containment success.
      const homeStores = [path.join(os.homedir(), ".ssh"), path.join(os.homedir(), ".aws")]
      for (const store of homeStores) {
        if (!fs.existsSync(store)) continue
        const result = await readProbe(fixture.path, store)
        expect({ store, readable: result.readable }).toEqual({ store, readable: false })
      }
      console.log(`[containment-baseline] credential reads denied: ${JSON.stringify(recorded)}`)
    } finally {
      for (const target of Object.values(synthetic)) fs.rmSync(target, { force: true })
    }
  })

  test("ordinary external reads still work", async () => {
    await using fixture = await tmpdir()

    const systemRoot = DEFAULT_SYSTEM_RUNTIME_READ_ROOTS.find((root) => fs.existsSync(root))
    expect(systemRoot).toBeDefined()
    const listing = await runInSandbox(
      fixture.path,
      `if ls ${shellQuote(systemRoot!)} >/dev/null 2>&1; then echo READ_OK; else echo READ_BLOCKED; fi`,
    )
    expect(listing.stdout).toContain("READ_OK")

    // /etc is deliberately outside the Linux restricted-mode read binds and
    // host-readable on macOS through the global read allow.
    if (process.platform === "darwin") {
      const hosts = await runInSandbox(
        fixture.path,
        `if cat /etc/hosts >/dev/null 2>&1; then echo READ_OK; else echo READ_BLOCKED; fi`,
      )
      expect(hosts.stdout).toContain("READ_OK")
    }

    const gitconfig = path.join(os.homedir(), ".gitconfig")
    if (fs.existsSync(gitconfig)) {
      const git = await runInSandbox(
        fixture.path,
        `if git config --get user.email >/dev/null 2>&1; then echo READ_OK; else echo READ_BLOCKED; fi`,
      )
      expect(git.stdout).toContain("READ_OK")
    }
    console.log(`[containment-baseline] ordinary external reads permitted through ${systemRoot}`)
  })

  test("workspace writes succeed", async () => {
    await using fixture = await tmpdir()
    const target = path.join(fixture.path, "workspace-probe.txt")
    const result = await runInSandbox(fixture.path, `echo payload > workspace-probe.txt && cat workspace-probe.txt`)
    expect(result.exitCode).toBe(0)
    expect(result.stdout.trim()).toBe("payload")
    expect(fs.readFileSync(target, "utf8").trim()).toBe("payload")
  })

  test("workspace-scoped controlled temp root writes succeed", async () => {
    await using fixture = await tmpdir()
    const controlled = controlledTempRoot(fixture.path, "containment-baseline")
    // Production (tools/bash/local.ts) creates this root host-side and points
    // TMPDIR/TMP/TEMP at it for sandboxed children.
    fs.mkdirSync(controlled, { recursive: true })
    const target = path.join(controlled, "tmp-probe.txt")

    const result = await runInSandbox(
      fixture.path,
      `echo payload > "$TMPDIR/tmp-probe.txt" && echo WROTE || echo BLOCKED`,
      { TMPDIR: controlled, TMP: controlled, TEMP: controlled },
    )
    expect(result.stdout).toContain("WROTE")
    expect(fs.readFileSync(target, "utf8").trim()).toBe("payload")

    // A child may also create the root itself, because it is inside the
    // workspace writable root.
    const nested = controlledTempRoot(fixture.path, "containment-baseline-nested")
    const created = await runInSandbox(
      fixture.path,
      `mkdir -p "$TMPDIR" && echo payload > "$TMPDIR/tmp-probe.txt" && echo WROTE || echo BLOCKED`,
      { TMPDIR: nested, TMP: nested, TEMP: nested },
    )
    expect(created.stdout).toContain("WROTE")
    expect(fs.readFileSync(path.join(nested, "tmp-probe.txt"), "utf8").trim()).toBe("payload")
  })

  test("protected metadata names stay blocked without a pre-existing directory", async () => {
    await using fixture = await tmpdir()
    for (const name of [".agents", ".codex"]) {
      const result = await runInSandbox(
        fixture.path,
        `mkdir -p ${name} && echo payload > ${name}/probe.txt && echo WROTE || echo BLOCKED`,
      )
      expect(result.stdout).toContain("BLOCKED")
      expect(fs.existsSync(path.join(fixture.path, name, "probe.txt"))).toBe(false)
    }
  })

  // -------------------------------------------------------------------------
  // REGRESSION — firmlink-aliased workspace must not widen a protected subpath.
  //
  // macOS firmlinks /var/folders and /tmp to /private/... . The parameterized
  // writable root is bound through its canonical path, so a protected-subpath
  // deny emitted in the alias spelling for a path that does not exist at
  // prepare time never intersects the allow and the deeper write allow wins.
  //
  // The deny must therefore be emitted in canonical form even when the final
  // component (`<workspace>/.git/hooks`) does not exist yet. Both spellings are
  // probed so a fix that simply swapped which spelling is bound would fail.
  // -------------------------------------------------------------------------
  test.skipIf(!FIRMLINKED_TMP)(
    "protected git subpaths stay unwritable through a firmlink-aliased workspace",
    async () => {
      await using fixture = await tmpdir()
      const canonical = fs.realpathSync(fixture.path)
      const workspace = canonical.replace(/^\/private\//, "/")
      expect(workspace).not.toBe(canonical)
      expect(fs.existsSync(workspace)).toBe(true)
      expect(fs.existsSync(path.join(workspace, ".git", "hooks"))).toBe(false)

      const wrapper = SandboxBackend.prepareWrapper({
        command: "/bin/sh",
        args: ["-c", "true"],
        workspace,
        sandboxMode: "workspace_write",
        networkMode: "restricted",
      })
      try {
        expect(wrapper.sandboxed).toBe(true)
        const sbpl = fs.readFileSync(wrapper.tempPath!, "utf8")
        // Allow and deny are bound through the same (canonical) spelling, so the
        // deny intersects the writable-root allow.
        expect(wrapper.args[wrapper.args.indexOf("-D") + 1]!.slice("PATH_WRITE_0=".length)).toBe(canonical)
        expect(sbpl).toContain(`(deny file-write* (subpath "${canonical}/.git/hooks"))`)
        expect(sbpl).not.toContain(`(subpath "${workspace}/.git/hooks")`)
      } finally {
        if (wrapper.tempPath) SandboxBackend.cleanupTemp(wrapper.tempPath)
      }

      const probe = `d=.git/hooks; mkdir -p "$d" && echo '#!/bin/sh' > "$d/pre-commit" || echo BLOCKED`
      const viaAlias = await runInSandbox(workspace, probe)
      const viaCanonical = await runInSandbox(canonical, probe)
      const planted = fs.existsSync(path.join(canonical, ".git", "hooks", "pre-commit"))
      console.log(
        `[containment-baseline] protected subpath probes: workspace=${workspace} canonical=${canonical} ` +
          `alias-stdout=${JSON.stringify(viaAlias.stdout.trim())} ` +
          `canonical-stdout=${JSON.stringify(viaCanonical.stdout.trim())} hook-planted=${planted}`,
      )
      try {
        expect({
          aliasWrote: viaAlias.stdout.includes("WROTE"),
          aliasBlocked: viaAlias.stdout.includes("BLOCKED"),
          canonicalWrote: viaCanonical.stdout.includes("WROTE"),
          canonicalBlocked: viaCanonical.stdout.includes("BLOCKED"),
          planted,
        }).toEqual({
          aliasWrote: false,
          aliasBlocked: true,
          canonicalWrote: false,
          canonicalBlocked: true,
          planted: false,
        })
      } finally {
        fs.rmSync(path.join(canonical, ".git"), { recursive: true, force: true })
      }
    },
  )
})
