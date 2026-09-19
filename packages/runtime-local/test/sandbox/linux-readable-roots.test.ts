// ---------------------------------------------------------------------------
// sandbox/linux-readable-roots.test.ts
//
// The Linux helper profile uses the same deny-list read model as macOS:
// reads are allowed globally and only credential and sensitive paths stay
// unreadable. The profile therefore declares "/" as its readable root, which
// makes the helper bind the host root read-only, and carries the credential
// deny list instead of enumerating read roots.
//
// Enumerating read roots was the old model: every host path a command might
// touch had to be predicted and granted, so ordinary external reads such as
// `cat /etc/hosts` failed unless the enforcement gate had anticipated the
// path. The deny list removes that dependency, and the dynamic-linker entry
// points (/lib, /lib64) that used to need explicit binds are covered by the
// root bind.
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
  return JSON.parse(fs.readFileSync(wrapper.tempPath!, "utf8")).fileSystem as {
    readableRoots: string[]
    writableRoots: string[]
    protectedPaths: string[]
    dataDenyRoots: string[]
  }
}

describe("Linux helper profile read model", () => {
  test("declares a full-read root instead of enumerating read roots", async () => {
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
    // "/" subsumes the workspace, the platform defaults, the gate-forwarded
    // roots, and the dynamic-linker entry points. A non-existent caller root is
    // harmless under this model: it is not a mount source, so bwrap cannot
    // hard-fail on it.
    expect(readProfile(wrapper).readableRoots).toEqual(["/"])

    fs.rmSync(wrapper.tempPath!, { force: true })
  })

  test("denies credential paths instead of granting them read access", async () => {
    await using tmp = await tmpdir()

    const wrapper = prepare({ workspace: tmp.path })

    expect(wrapper.sandboxed).toBe(true)
    const { dataDenyRoots } = readProfile(wrapper)

    // Credentials are what keep a global read allow safe, so the deny list must
    // be populated on Linux exactly as it is on macOS. An empty list here would
    // silently expose every credential store on the host.
    const homedir = os.homedir()
    for (const credential of [".ssh", ".aws", ".gnupg", ".netrc", ".git-credentials"]) {
      expect({ credential, denied: dataDenyRoots }).toEqual({
        credential,
        denied: expect.arrayContaining([path.join(homedir, credential)]),
      })
    }

    fs.rmSync(wrapper.tempPath!, { force: true })
  })

  test("home-shaped workspace keeps credential denies in the helper profile", () => {
    // The configuration whose deny set collapsed to zero: the Scope directory
    // resolves to the home directory itself. Linux has no `--tmpfs /` model
    // left to hide these paths, so the profile's deny list is the only thing
    // keeping them unreadable. Measured through the real backend entry point,
    // since the deny owner derives its scope from the writable roots the
    // backend computes rather than from a caller-supplied list.
    const homedir = os.homedir()
    const wrapper = prepare({ workspace: homedir })

    expect(wrapper.sandboxed).toBe(true)
    const { dataDenyRoots, writableRoots } = readProfile(wrapper)

    expect(writableRoots).toContain(homedir)
    expect(dataDenyRoots.length).toBeGreaterThan(0)
    for (const credential of [".ssh", ".aws", ".gnupg", ".netrc", ".git-credentials"]) {
      expect({ credential, denied: dataDenyRoots }).toEqual({
        credential,
        denied: expect.arrayContaining([path.join(homedir, credential)]),
      })
    }

    fs.rmSync(wrapper.tempPath!, { force: true })
  })

  test("never denies the workspace or its writable roots", async () => {
    await using tmp = await tmpdir()
    const workspace = tmp.path
    const extraWritable = path.join(workspace, "generated")
    await fs.promises.mkdir(extraWritable, { recursive: true })

    const wrapper = SandboxBackend.prepareWrapper({
      command: "echo",
      args: ["hello"],
      workspace,
      sandboxMode: "workspace_write",
      forcePlatform: "linux",
      forceHelperPath: "/test/synergy-sandbox-linux",
      forceHelperVerified: true,
      extraWritableRoots: [extraWritable],
    })

    expect(wrapper.sandboxed).toBe(true)
    const profile = readProfile(wrapper)

    // A deny covering the workspace would make the project's own files
    // unreadable. A deny inside a writable root is kept and enforced by mount
    // order (the helper emits it after the writable bind), but no credential
    // deny falls inside this temporary workspace, so none is expected here.
    for (const deny of profile.dataDenyRoots) {
      expect({ deny, inWorkspace: deny === workspace || deny.startsWith(workspace + "/") }).toEqual({
        deny,
        inWorkspace: false,
      })
    }
    expect(profile.writableRoots).toContain(workspace)

    fs.rmSync(wrapper.tempPath!, { force: true })
  })

  test("stages a tmpdir helper outside the shadowed /tmp", async () => {
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
    const relToTmp = path.relative(os.tmpdir(), helperPath)
    if (relToTmp !== "" && !relToTmp.startsWith("..") && !path.isAbsolute(relToTmp)) {
      // The full-read root bind does not help here: the plan's controlled-/tmp
      // bind still shadows every host path under /tmp, and stage 2 re-execs the
      // helper by absolute path, so a helper under /tmp must be copied out
      // before it is exec'd.
      expect(wrapper.command).not.toBe(helperPath)
      const relExecToTmp = path.relative(os.tmpdir(), wrapper.command)
      expect({
        staged: relExecToTmp === "" || relExecToTmp.startsWith("..") || path.isAbsolute(relExecToTmp),
      }).toEqual({ staged: true })
      // Never leave a test helper behind in the real home.
      fs.rmSync(wrapper.command, { force: true })
    } else {
      expect(wrapper.command).toBe(helperPath)
    }

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
        // outside test isolation. No extraReadRoots here: staging the exec
        // copy for the stage-2 re-exec is the backend's own invariant, and
        // this execution is its regression test.
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
