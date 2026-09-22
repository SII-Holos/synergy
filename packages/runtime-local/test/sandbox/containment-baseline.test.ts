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
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
// Linux replaces /tmp in the sandbox; its execution probes need an owned Home outside that mount.
const probeRoot = path.resolve(import.meta.dir, "../../.artifacts/sandbox-probes")
if (process.platform === "linux") fs.mkdirSync(probeRoot, { recursive: true })
const home = process.platform === "linux" ? fs.mkdtempSync(path.join(probeRoot, "home-")) : undefined
const runtime = await testRuntime({ home }).catch((error) => {
  if (home) fs.rmSync(home, { recursive: true, force: true })
  throw error
})

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

const availability = runtime.run(detectAvailability)

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
async function runInSandbox(
  workspace: string,
  command: string,
  opts: { env?: Record<string, string>; dataDenyRoots?: string[] } = {},
): Promise<ProbeResult> {
  const wrapper = SandboxBackend.prepareWrapper({
    command: "/bin/sh",
    args: ["-c", command],
    workspace,
    sandboxMode: "workspace_write",
    networkMode: "restricted",
    ...(opts.dataDenyRoots ? { dataDenyRoots: opts.dataDenyRoots } : {}),
  })
  try {
    const result = await SandboxBackend.executeAsync(wrapper, {
      fallbackPolicy: "deny",
      cwd: workspace,
      env: opts.env,
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

/**
 * Workspace for a real-execution probe.
 *
 * The Linux helper binds `<workspace>/.synergy/tmp` over `/tmp`, so a workspace
 * created under `/tmp` — where the test fixture root lives — is shadowed inside
 * its own sandbox and every command fails to start. Linux probes therefore take
 * a workspace under the runtime home, mirroring the real-helper end-to-end in
 * `linux-readable-roots.test.ts`. On macOS the ordinary fixture root is visible
 * and is used as-is.
 */
async function probeWorkspace(): Promise<{ path: string; dispose: () => void }> {
  if (process.platform !== "linux") {
    const fixture = await tmpdir()
    return { path: fixture.path, dispose: () => {} }
  }
  const root = path.join(runtime.host.home, ".synergy", "tmp")
  fs.mkdirSync(root, { recursive: true })
  const workspace = fs.mkdtempSync(path.join(root, "containment-baseline-"))
  return { path: workspace, dispose: () => fs.rmSync(workspace, { recursive: true, force: true }) }
}

/**
 * A probe proves nothing if the shell never started. Each probe reports whether
 * it emitted its sentinel at all, and every caller asserts that, so a backend
 * that fails to launch cannot make a containment assertion pass by producing
 * empty output.
 */
async function writeProbe(workspace: string, target: string) {
  const result = await runInSandbox(workspace, `echo probe > ${shellQuote(target)} && echo WROTE || echo BLOCKED`)
  return {
    ran: result.stdout.includes("WROTE") || result.stdout.includes("BLOCKED"),
    wrote: result.stdout.includes("WROTE"),
    blocked: result.stdout.includes("BLOCKED"),
    hostFileExists: fs.existsSync(target),
    stdout: result.stdout,
    stderr: result.stderr.trim(),
  }
}

/**
 * Read a path inside the sandbox and return every output channel plus the exit
 * status.
 *
 * A denial is asserted as the absence of the file's *body*, not as a failing
 * `cat`. macOS refuses the read, while the Linux helper covers the path with an
 * empty mount, so the same denial surfaces as an empty, successful read.
 * Callers place a unique marker in the file and require that no channel of the
 * run ever carried it, and that the probe reported its exit status at all —
 * together those hold identically on both backends and cannot pass when the
 * child failed to launch.
 */
async function readOutput(
  workspace: string,
  target: string,
  opts: { dataDenyRoots?: string[] } = {},
): Promise<{ output: string; ran: boolean }> {
  const result = await runInSandbox(workspace, `cat ${shellQuote(target)} 2>&1; echo "EXIT:$?"`, opts)
  const output = result.stdout + result.stderr
  return { output, ran: output.includes("EXIT:") }
}

describe.skipIf(!availability.available)("OS sandbox containment baseline", () => {
  test("external write targets stay unwritable", () =>
    runtime.run(async () => {
      const workspace = await probeWorkspace()
      const id = probeId()
      const targets: Record<string, string> = {
        "system /etc": `/etc/harness-baseline-probe-${id}`,
        "user home": path.join(runtime.host.home, `.harness-baseline-probe-${id}`),
        "shared temp": `/tmp/harness-baseline-probe-${id}`,
      }
      const recorded: Record<string, { ran: boolean; blocked: boolean; wrote: boolean; hostFileExists: boolean }> = {}
      try {
        for (const [label, target] of Object.entries(targets)) {
          const result = await writeProbe(workspace.path, target)
          recorded[label] = {
            ran: result.ran,
            blocked: result.blocked,
            wrote: result.wrote,
            hostFileExists: result.hostFileExists,
          }
        }

        // A probe that never emitted a sentinel proves nothing, so the shell
        // must have actually run before any containment claim is made.
        for (const [label, result] of Object.entries(recorded)) {
          expect({ label, ran: result.ran }).toEqual({ label, ran: true })
        }
        // The containment property is that no host file is created, and that
        // holds on every backend. The observable *signal* differs by backend:
        // macOS denies the write (allow-list Seatbelt profile, denial reported),
        // while the Linux plan starts from `tmpfs /`, so the write lands in the
        // sandbox's private filesystem and the command reports success without
        // ever reaching the host. Asserting the signal would make one platform's
        // shape a requirement for the other; the invariant is asserted instead,
        // and the signal is recorded so a backend whose containment regresses to
        // "wrote to the host" cannot pass.
        for (const [label, result] of Object.entries(recorded)) {
          expect({ label, hostFileExists: result.hostFileExists }).toEqual({ label, hostFileExists: false })
        }
        if (process.platform === "darwin") {
          expect(recorded["system /etc"]).toEqual({
            ran: true,
            blocked: true,
            wrote: false,
            hostFileExists: false,
          })
          expect(recorded["user home"]).toEqual({
            ran: true,
            blocked: true,
            wrote: false,
            hostFileExists: false,
          })
        }
        // The home target is writable by this user outside the sandbox, so a
        // `false` above is attributable to the sandbox rather than to host
        // ownership of the parent directory.
        expect(hostWriteBaseline(targets["user home"]!)).toBe(true)
        console.log(`[containment-baseline] external writes contained: ${JSON.stringify(recorded)}`)
      } finally {
        for (const target of Object.values(targets)) fs.rmSync(target, { force: true, recursive: true })
        workspace.dispose()
      }
    }))

  test("credential paths stay unreadable", () =>
    runtime.run(async () => {
      const testHome = runtime.host.home
      if (!testHome) throw new Error("SYNERGY_TEST_HOME is not set; the test preload is not active")
      const workspace = await probeWorkspace()

      const marker = `SYNERGY-CONTAINMENT-MARKER-${probeId()}`
      // A synthetic credential root inside the OS home. Using an injected deny
      // root keeps the probe end to end — the deny is decided by the same profile
      // field production uses — without mutating the real user's credential
      // stores. The sibling file outside the denied root is the control: if the
      // sandbox could not see the OS home at all, both reads would be empty and
      // the deny assertion below would pass vacuously.
      const denyRoot = path.join(runtime.host.home, `.harness-baseline-deny-${probeId()}`)
      const deniedSecret = path.join(denyRoot, "id_rsa")
      const allowedSibling = path.join(runtime.host.home, `.harness-baseline-allow-${probeId()}`)
      fs.mkdirSync(denyRoot, { recursive: true })
      fs.writeFileSync(deniedSecret, `${marker}-denied\n`)
      fs.writeFileSync(allowedSibling, `${marker}-allowed\n`)

      const synthetic = {
        "ssh private key": path.join(testHome, ".ssh", "id_rsa"),
        "aws credentials": path.join(testHome, ".aws", "credentials"),
      }
      for (const [index, target] of Object.values(synthetic).entries()) {
        fs.mkdirSync(path.dirname(target), { recursive: true })
        fs.writeFileSync(target, `${marker}-${index}\n`)
      }

      // The isolated test home lives under the host tmpdir, which the Linux helper
      // replaces with the workspace controlled tmp. A credential there can be
      // invisible inside that sandbox for reasons unrelated to the read deny, so a
      // non-credential sibling decides whether those probes are meaningful.
      const testHomeControl = path.join(testHome, `containment-control-${probeId()}`)
      fs.writeFileSync(testHomeControl, `${marker}-control\n`)

      try {
        // Host baselines: every probe target is readable outside the sandbox, so
        // each denial below is attributable to the sandbox and not to host
        // permissions or a missing file.
        for (const target of [deniedSecret, allowedSibling]) {
          expect(fs.readFileSync(target, "utf8")).toContain(marker)
        }

        // Control: the OS home is visible and readable inside the sandbox.
        const sibling = await readOutput(workspace.path, allowedSibling)
        expect({ target: "home sibling", ran: sibling.ran, leaked: sibling.output.includes(marker) }).toEqual({
          target: "home sibling",
          ran: true,
          leaked: true,
        })

        // The deny is enforced. This is the Linux half that the read-model
        // convergence must not regress: the shell ran, the surrounding directory
        // is readable, and the denied body never appears.
        const denied = await readOutput(workspace.path, deniedSecret, { dataDenyRoots: [denyRoot] })
        expect({ target: "denied secret", ran: denied.ran, leaked: denied.output.includes(marker) }).toEqual({
          target: "denied secret",
          ran: true,
          leaked: false,
        })

        // Directory-level credential stores are deliberately not probed here: a
        // `cat` of a directory fails on every backend whether or not it is
        // denied, so the observation would prove nothing, and a real credential
        // *file* probe could put live key material in a test's output. The deny
        // list itself is asserted at profile level in linux-readable-roots.test.ts
        // and macos-policy.test.ts; the functional evidence above is non-vacuous
        // because the control sibling in the same home is read successfully.

        const control = await readOutput(workspace.path, testHomeControl)
        if (control.ran && control.output.includes(marker)) {
          const recorded: Record<string, boolean> = {}
          for (const [label, target] of Object.entries(synthetic)) {
            expect(fs.readFileSync(target, "utf8")).toContain(marker)
            const result = await readOutput(workspace.path, target)
            expect({ label, ran: result.ran }).toEqual({ label, ran: true })
            recorded[label] = result.output.includes(marker)
          }
          expect(recorded).toEqual({ "ssh private key": false, "aws credentials": false })
          console.log(`[containment-baseline] isolated-home credential leaks: ${JSON.stringify(recorded)}`)
        } else {
          console.log(
            "[containment-baseline] isolated test home is not visible inside this sandbox; " +
              "credential evidence comes from the OS-home probes",
          )
        }
        console.log("[containment-baseline] credential reads denied")
      } finally {
        for (const target of Object.values(synthetic)) fs.rmSync(target, { force: true })
        fs.rmSync(testHomeControl, { force: true })
        fs.rmSync(allowedSibling, { force: true })
        fs.rmSync(denyRoot, { recursive: true, force: true })
        workspace.dispose()
      }
    }))

  test("ordinary external reads still work", () =>
    runtime.run(async () => {
      const workspace = await probeWorkspace()

      try {
        // The read model is the credential deny list, not a granted-root list, so
        // a path no enumeration would have covered must still be readable. On
        // Linux this is the fact that lets the enforcement gate stop predicting
        // which paths a shell command will touch: without it, removing that
        // prediction turns ordinary external reads into sandbox failures.
        const marker = `SYNERGY-READ-BASELINE-${probeId()}`
        const externalRead = path.join(runtime.host.home, `.harness-baseline-read-${probeId()}`)
        fs.writeFileSync(externalRead, `${marker}\n`)
        try {
          expect(fs.readFileSync(externalRead, "utf8")).toContain(marker)
          const probe = await readOutput(workspace.path, externalRead)
          expect({ target: "os home file", ran: probe.ran, read: probe.output.includes(marker) }).toEqual({
            target: "os home file",
            ran: true,
            read: true,
          })
        } finally {
          fs.rmSync(externalRead, { force: true })
        }

        // /etc is outside the restricted-mode read binds the Linux enumeration
        // produced and host-readable on macOS through the global read allow.
        const hosts = await readOutput(workspace.path, "/etc/hosts")
        expect({ target: "/etc/hosts", ran: hosts.ran, read: /EXIT:0/.test(hosts.output) }).toEqual({
          target: "/etc/hosts",
          ran: true,
          read: true,
        })

        const gitconfig = path.join(runtime.host.home, ".gitconfig")
        if (fs.existsSync(gitconfig)) {
          const config = await readOutput(workspace.path, gitconfig)
          expect({ target: ".gitconfig", ran: config.ran, read: /EXIT:0/.test(config.output) }).toEqual({
            target: ".gitconfig",
            ran: true,
            read: true,
          })
        }

        const systemRoot = DEFAULT_SYSTEM_RUNTIME_READ_ROOTS.find((root) => fs.existsSync(root))
        expect(systemRoot).toBeDefined()
        const listing = await runInSandbox(
          workspace.path,
          `if ls ${shellQuote(systemRoot!)} >/dev/null 2>&1; then echo READ_OK; else echo READ_BLOCKED; fi`,
        )
        expect(listing.stdout).toContain("READ_OK")
        console.log(`[containment-baseline] ordinary external reads permitted through ${systemRoot}`)
      } finally {
        workspace.dispose()
      }
    }))

  test("workspace writes succeed", () =>
    runtime.run(async () => {
      const workspace = await probeWorkspace()
      const target = path.join(workspace.path, "workspace-probe.txt")
      const result = await runInSandbox(workspace.path, `echo payload > workspace-probe.txt && cat workspace-probe.txt`)
      expect(result.exitCode).toBe(0)
      expect(result.stdout.trim()).toBe("payload")
      expect(fs.readFileSync(target, "utf8").trim()).toBe("payload")
      workspace.dispose()
    }))

  test("workspace-scoped controlled temp root writes succeed", () =>
    runtime.run(async () => {
      const workspace = await probeWorkspace()
      const controlled = controlledTempRoot(workspace.path, "containment-baseline")
      // Production (tools/bash/local.ts) creates this root host-side and points
      // TMPDIR/TMP/TEMP at it for sandboxed children.
      fs.mkdirSync(controlled, { recursive: true })
      const target = path.join(controlled, "tmp-probe.txt")

      const result = await runInSandbox(
        workspace.path,
        `echo payload > "$TMPDIR/tmp-probe.txt" && echo WROTE || echo BLOCKED`,
        { env: { TMPDIR: controlled, TMP: controlled, TEMP: controlled } },
      )
      expect(result.stdout).toContain("WROTE")
      expect(fs.readFileSync(target, "utf8").trim()).toBe("payload")

      // A child may also create the root itself, because it is inside the
      // workspace writable root.
      const nested = controlledTempRoot(workspace.path, "containment-baseline-nested")
      const created = await runInSandbox(
        workspace.path,
        `mkdir -p "$TMPDIR" && echo payload > "$TMPDIR/tmp-probe.txt" && echo WROTE || echo BLOCKED`,
        { env: { TMPDIR: nested, TMP: nested, TEMP: nested } },
      )
      expect(created.stdout).toContain("WROTE")
      expect(fs.readFileSync(path.join(nested, "tmp-probe.txt"), "utf8").trim()).toBe("payload")
      workspace.dispose()
    }))

  test("protected metadata names stay blocked without a pre-existing directory", () =>
    runtime.run(async () => {
      const workspace = await probeWorkspace()
      try {
        for (const name of [".agents", ".codex"]) {
          const result = await runInSandbox(
            workspace.path,
            `mkdir -p ${name} && echo payload > ${name}/probe.txt && echo WROTE || echo BLOCKED`,
          )
          // The invariant is that no protected metadata entry survives: macOS
          // refuses the write outright (BLOCKED), while the Linux helper lets the
          // sandbox create it and then removes the violating entry from the host
          // through its create monitor, so the command reports success. Asserting
          // one backend's signal would make it a requirement for the other, and
          // asserting only the signal would miss a backend that failed to launch.
          expect({ name, ran: result.stdout.includes("WROTE") || result.stdout.includes("BLOCKED") }).toEqual({
            name,
            ran: true,
          })
          expect({ name, persisted: fs.existsSync(path.join(workspace.path, name, "probe.txt")) }).toEqual({
            name,
            persisted: false,
          })
          expect({ name, persistedDir: fs.existsSync(path.join(workspace.path, name)) }).toEqual({
            name,
            persistedDir: false,
          })
        }
      } finally {
        workspace.dispose()
      }
    }))

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
  test.skipIf(!FIRMLINKED_TMP)("protected git subpaths stay unwritable through a firmlink-aliased workspace", () =>
    runtime.run(async () => {
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
    }),
  )
})

afterRuntimeTests(async () => {
  try {
    await runtime.close()
  } finally {
    if (home) fs.rmSync(home, { recursive: true, force: true })
  }
})
