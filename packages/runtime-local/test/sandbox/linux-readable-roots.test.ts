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

  test("real helper executes a child end to end when the host allows it", async () => {
    if (process.platform !== "linux") return
    // Real helper from the host install: proves the full prepare → stage-1 →
    // bwrap → stage-2 → child chain, including the cache-dir profile staging
    // that stage 2 re-reads inside the sandbox. Skips honestly where the
    // host has no helper or blocks unprivileged user namespaces
    // (environment, not a code defect).
    const helperPath = path.join(os.homedir(), ".synergy", "sandbox-helper", "synergy-sandbox-linux")
    if (!fs.existsSync(helperPath)) return
    const probe = Bun.spawnSync(["bwrap", "--dev-bind", "/", "/", "/bin/true"])
    if (probe.exitCode !== 0) return
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
        // outside test isolation.
        forceHelperPath: helperPath,
        forceHelperVerified: true,
        // Mirrors the production call site: the helper re-execs itself inside
        // the sandbox, so its install root must be readable there.
        extraReadRoots: [path.join(os.homedir(), ".synergy")],
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
