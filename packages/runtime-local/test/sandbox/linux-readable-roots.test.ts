// ---------------------------------------------------------------------------
// sandbox/linux-readable-roots.test.ts
//
// The Linux helper profile must only list readable roots that exist on disk.
// bwrap hard-fails when a --ro-bind source is missing, and the aggregated
// readableRoots mix platform defaults (macOS-only entries on Linux),
// gate-forwarded roots, and approved read paths — so existence filtering
// happens at wrapper-prepare time, like protectedPaths and network config
// roots already are.
//
// Dynamically linked children additionally need the ELF interpreter entry
// points (/lib, /lib64) to be visible or every exec dies with ENOENT.
//
// Run with:
//   cd packages/runtime-local && bun test test/sandbox/linux-readable-roots.test.ts
// ---------------------------------------------------------------------------

import { describe, expect, test } from "bun:test"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { SandboxBackend } from "../../src/sandbox/backend"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"

function prepare(input: { workspace: string; runtimeReadRoots?: string[]; extraReadRoots?: string[] }) {
  return SandboxBackend.prepareWrapper({
    command: "echo",
    args: ["hello"],
    workspace: input.workspace,
    sandboxMode: "workspace_write",
    forcePlatform: "linux",
    forceHelperPath: "/test/synergy-sandbox-linux",
    forceHelperVerified: true,
    runtimeReadRoots: input.runtimeReadRoots,
    extraReadRoots: input.extraReadRoots,
  })
}

function readProfile(wrapper: { tempPath?: string }) {
  const profile = JSON.parse(fs.readFileSync(wrapper.tempPath!, "utf8"))
  return profile.fileSystem.readableRoots as string[]
}

describe("Linux helper profile readable roots", () => {
  test("filters non-existent readable roots so bwrap does not hard-fail", async () => {
    await using tmp = await tmpdir()
    const existing = path.join(tmp.path, "existing-root")
    await fs.promises.mkdir(existing, { recursive: true })
    const missing = path.join(tmp.path, "missing-root")

    const wrapper = prepare({
      workspace: tmp.path,
      runtimeReadRoots: [existing, missing],
      extraReadRoots: [missing],
    })

    expect(wrapper.sandboxed).toBe(true)
    const roots = readProfile(wrapper)

    expect(roots).toContain(tmp.path)
    expect(roots).toContain(existing)
    expect(roots).not.toContain(missing)

    fs.rmSync(wrapper.tempPath!, { force: true })
  })

  test("default runtime roots are existence-filtered on every host", async () => {
    await using tmp = await tmpdir()

    const wrapper = prepare({ workspace: tmp.path })

    expect(wrapper.sandboxed).toBe(true)
    const roots = readProfile(wrapper)

    expect(roots.length).toBeGreaterThan(0)
    for (const root of roots) {
      expect(fs.existsSync(root)).toBe(true)
    }

    fs.rmSync(wrapper.tempPath!, { force: true })
  })

  test("includes dynamic linker roots so executables can start", async () => {
    await using tmp = await tmpdir()

    const wrapper = prepare({ workspace: tmp.path })

    expect(wrapper.sandboxed).toBe(true)
    const roots = readProfile(wrapper)

    // The ELF interpreter lives at /lib64/ld-linux-*.so.2 on usr-merged
    // distros (or /lib/ld-musl-*.so.1 on musl); without these binds every
    // dynamically linked child dies with execvp ENOENT.
    for (const root of ["/lib", "/lib64"]) {
      if (!fs.existsSync(root)) continue
      expect(roots).toContain(root)
    }

    fs.rmSync(wrapper.tempPath!, { force: true })
  })

  test("helper install directory is bound so stage 2 can re-exec", async () => {
    await using tmp = await tmpdir()
    const helperDir = path.join(tmp.path, "helper-install")
    await fs.promises.mkdir(helperDir, { recursive: true })
    const helperPath = path.join(helperDir, "synergy-sandbox-linux")
    await fs.promises.writeFile(helperPath, "#!/bin/sh\n", { mode: 0o755 })

    const wrapper = SandboxBackend.prepareWrapper({
      command: "echo",
      args: ["hello"],
      workspace: tmp.path,
      sandboxMode: "workspace_write",
      forcePlatform: "linux",
      forceHelperPath: helperPath,
      forceHelperVerified: true,
    })

    expect(wrapper.sandboxed).toBe(true)
    expect(readProfile(wrapper)).toContain(helperDir)

    fs.rmSync(wrapper.tempPath!, { force: true })
  })

  test("real helper executes a child end to end when the host allows it", async () => {
    // SYNERGY_TEST_LINUX_SANDBOX_E2E=1 (CI runtime shard) turns every skip
    // below into a hard failure: CI installs bwrap, the AppArmor userns
    // profile, and the helper, so a silent skip would hide a broken sandbox
    // behind a green build. Locally the test still skips honestly — a
    // missing helper or blocked user namespaces there is environment, not
    // a code defect.
    const enforced = process.env.SYNERGY_TEST_LINUX_SANDBOX_E2E === "1"
    if (process.platform !== "linux") {
      if (enforced) throw new Error("SYNERGY_TEST_LINUX_SANDBOX_E2E=1 requires a Linux runner")
      return
    }
    // Real helper from the host install: proves the full prepare → stage-1 →
    // bwrap → stage-2 → child chain, including the cache-dir profile staging
    // that stage 2 re-reads inside the sandbox.
    const helperPath = path.join(os.homedir(), ".synergy", "sandbox-helper", "synergy-sandbox-linux")
    if (!fs.existsSync(helperPath)) {
      if (enforced) {
        throw new Error(
          `SYNERGY_TEST_LINUX_SANDBOX_E2E=1 but the sandbox helper is missing at ${helperPath}; ` +
            "the CI runtime shard must build and install it",
        )
      }
      return
    }
    const probe = Bun.spawnSync({
      cmd: ["bwrap", "--dev-bind", "/", "/", "/bin/true"],
      stdout: "pipe",
      stderr: "pipe",
    })
    if (probe.exitCode !== 0) {
      if (enforced) {
        const detail = [probe.stderr, probe.stdout]
          .filter((bytes) => bytes.length > 0)
          .map((bytes) => new TextDecoder().decode(bytes))
          .join(" ")
          .trim()
        throw new Error(
          `SYNERGY_TEST_LINUX_SANDBOX_E2E=1 but bwrap cannot create a sandbox (exit ${probe.exitCode}); ` +
            `install the AppArmor userns profile for /usr/bin/bwrap${detail ? `: ${detail}` : ""}`,
        )
      }
      return
    }
    // The helper's controlled-tmp bind shadows everything under /tmp, so the
    // workspace must live outside it — mirrors production, where workspaces
    // are real project directories.
    const wsRoot = path.join(os.homedir(), ".synergy", "tmp")
    fs.mkdirSync(wsRoot, { recursive: true })
    const wsPath = fs.mkdtempSync(path.join(wsRoot, "sandbox-e2e-"))
    try {
      const wrapper = SandboxBackend.prepareWrapper({
        command: "/bin/sh",
        args: ["-c", "echo linux-sandbox-exec-ok"],
        workspace: wsPath,
        sandboxMode: "workspace_write",
        // Test-only helper override; production discovery is exercised
        // outside test isolation. No extraReadRoots here: binding the
        // helper's install directory for the stage-2 re-exec is the
        // backend's own invariant, and this execution is its regression
        // test.
        forceHelperPath: helperPath,
        forceHelperVerified: true,
      })
      expect(wrapper.sandboxed).toBe(true)

      const result = await SandboxBackend.executeAsync(wrapper, {
        fallbackPolicy: "deny",
        cwd: wsPath,
        networkMode: "restricted",
      })

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain("linux-sandbox-exec-ok")
    } finally {
      fs.rmSync(wsPath, { recursive: true, force: true })
    }
  })
})
