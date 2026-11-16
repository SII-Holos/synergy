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
//   cd packages/local-runtime && bun test test/sandbox/linux-readable-roots.test.ts
// ---------------------------------------------------------------------------

import { describe, expect, test } from "bun:test"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { SandboxBackend } from "../../src/sandbox/backend"
import { NativeExecutor } from "../../src/environment/native-executor"
import { WorkspaceCoordinator } from "../../src/workspace/coordinator"
import { ExecutionProtocol } from "@ericsanchezok/synergy-harness/environment/executor"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()

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
  test("declares a full-read root instead of enumerating read roots", () =>
    runtime.run(async () => {
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
    }))

  test("denies credential paths instead of granting them read access", () =>
    runtime.run(async () => {
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
    }))

  test("home-shaped workspace keeps credential denies in the helper profile", () =>
    runtime.run(() => {
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
    }))

  test("never denies the workspace or its writable roots", () =>
    runtime.run(async () => {
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
    }))

  test("stages a tmpdir helper outside the shadowed /tmp", () =>
    runtime.run(async () => {
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
    }))

  for (const { location, mode, ancestor, blocked, denyParent, protectTmp } of [
    { location: "home", mode: "workspace_write", ancestor: null, blocked: false, denyParent: false, protectTmp: false },
    {
      location: "temporary",
      mode: "workspace_write",
      ancestor: null,
      blocked: false,
      denyParent: false,
      protectTmp: false,
    },
    { location: "home", mode: "read_only", ancestor: null, blocked: false, denyParent: false, protectTmp: false },
    { location: "temporary", mode: "read_only", ancestor: null, blocked: false, denyParent: false, protectTmp: false },
    {
      location: "temporary",
      mode: "workspace_write",
      ancestor: "/tmp",
      blocked: false,
      denyParent: false,
      protectTmp: false,
    },
    {
      location: "temporary",
      mode: "workspace_write",
      ancestor: "/",
      blocked: false,
      denyParent: false,
      protectTmp: false,
    },
    {
      location: "temporary",
      mode: "workspace_write",
      ancestor: "/",
      blocked: false,
      denyParent: false,
      protectTmp: true,
    },
    { location: "temporary", mode: "read_only", ancestor: null, blocked: true, denyParent: true, protectTmp: false },
    {
      location: "temporary",
      mode: "workspace_write",
      ancestor: null,
      blocked: false,
      denyParent: true,
      protectTmp: false,
    },
  ] as const)
    test(`real helper executes a selected native child in ${location} with ${mode}, ancestor ${ancestor ?? "none"}, parent denial ${denyParent}, temporary protection ${protectTmp}`, () =>
      runtime.run(async () => {
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
        const wsRoot = location === "temporary" ? os.tmpdir() : path.join(os.homedir(), ".synergy", "tmp")
        fs.mkdirSync(wsRoot, { recursive: true })
        const fixture = fs.mkdtempSync(path.join(wsRoot, "sandbox-e2e-"))
        const outsideRoot = path.join(os.homedir(), ".synergy", "tmp")
        fs.mkdirSync(outsideRoot, { recursive: true })
        const outside = fs.mkdtempSync(path.join(outsideRoot, "sandbox-escape-"))
        const hostTmp = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-host-tmp-"))
        const sentinel = path.join(hostTmp, "sentinel")
        fs.writeFileSync(sentinel, "host-only-fixture")
        const wsPath = path.join(fixture, "workspace")
        fs.mkdirSync(path.join(wsPath, "private"), { recursive: true })
        fs.writeFileSync(path.join(wsPath, "readable"), "native-input")
        fs.writeFileSync(path.join(wsPath, "private", "secret"), "private-fixture")
        fs.writeFileSync(path.join(wsPath, "protected"), "protected-fixture")
        fs.symlinkSync("private", path.join(wsPath, "private-alias"))
        fs.symlinkSync(outside, path.join(wsPath, "escape-alias"))
        fs.symlinkSync(sentinel, path.join(wsPath, "host-tmp-alias"))
        try {
          expect(fs.realpathSync(hostTmp).startsWith("/tmp/")).toBe(true)
          const target = { environmentID: "linux-sandbox", allocationID: "temporary-workspace", generation: 1 }
          await using executor = await NativeExecutor.open({
            target,
            directory: path.join(fixture, "receipts"),
            coordinator: new WorkspaceCoordinator({ directory: path.join(fixture, "claims") }),
            sandbox: {
              prepareWrapper: (input) =>
                SandboxBackend.prepareWrapper({ ...input, forceHelperPath: helperPath, forceHelperVerified: true }),
              cleanupWrapper: SandboxBackend.cleanupWrapper,
            },
          })
          const id = "temporary-sandbox-operation"
          const wrapper = await executor.prepareSandbox({
            operationID: id,
            command: "/bin/sh",
            args: [
              "-c",
              [
                "set -eu",
                'test "$(pwd -P)" = "$1"',
                "test -x /bin/sh",
                "test -r /etc/hosts",
                'test "$(cat readable)" = native-input',
                "if cat private/secret 2>/dev/null; then exit 20; fi",
                "if cat private-alias/secret 2>/dev/null; then exit 21; fi",
                "if { printf changed >> protected; } 2>/dev/null; then exit 22; fi",
                'if [ "$5" != / ]; then',
                '  if { printf escaped > "$2"; } 2>/dev/null; then exit 23; fi',
                "  if { printf escaped > escape-alias/escaped; } 2>/dev/null; then exit 25; fi",
                "fi",
                'if cat "$4" 2>/dev/null; then exit 26; fi',
                "if cat host-tmp-alias 2>/dev/null; then exit 27; fi",
                'mkdir -p "${4%/*}"',
                "printf isolated > host-tmp-alias",
                'if [ "$3" = workspace_write ]; then printf allowed > allowed; elif { printf allowed > allowed; } 2>/dev/null; then exit 24; fi',
                "printf controlled > /tmp/sandbox-e2e-controlled",
                "printf linux-sandbox-exec-ok",
              ].join("\n"),
              "linux-sandbox",
              fs.realpathSync(wsPath),
              path.join(outside, "escaped"),
              protectTmp ? "read_only" : mode,
              sentinel,
              ancestor ?? "",
            ],
            workspace: wsPath,
            sandboxMode: mode,
            networkMode: "restricted",
            extraWritableRoots: ancestor ? [ancestor] : [],
            dataDenyRoots: [path.join(wsPath, "private"), ...(denyParent ? [fixture] : [])],
            protectedPaths: [
              path.join(wsPath, "protected"),
              ...(protectTmp ? ["/tmp"] : []),
              ...(blocked ? [fixture] : []),
            ],
          })
          expect(wrapper.sandboxed).toBe(true)
          expect(await executor.inspectPreparation(id)).toMatchObject({ id, target, state: "prepared" })
          const command = {
            command: wrapper.command,
            args: wrapper.args,
            cwd: wsPath,
            env: {},
            useRoots: [wsPath],
            sandboxID: wrapper.id,
          }
          const request = { id, target, command, digest: ExecutionProtocol.digest(command) }
          await executor.start(request)
          let status = await executor.status(id)
          for (let attempt = 0; status && !ExecutionProtocol.terminal(status) && attempt < 400; attempt++) {
            await Bun.sleep(10)
            status = await executor.status(id)
          }
          const chunks = await executor.output(id, 0, 128)
          const output = ["stdout", "stderr"].map((stream) =>
            chunks
              .filter((chunk) => chunk.stream === stream)
              .map((chunk) => Buffer.from(chunk.data, "base64").toString())
              .join(""),
          )
          expect({ status, stdout: output[0], stderr: output[1] }).toMatchObject({
            status: { target, state: "exited", exitCode: blocked ? 1 : 0 },
            stdout: blocked ? "" : "linux-sandbox-exec-ok",
          })
          expect(await Bun.file(path.join(wsPath, "allowed")).exists()).toBe(
            !blocked && mode === "workspace_write" && !protectTmp,
          )
          expect(await Bun.file(path.join(wsPath, "protected")).text()).toBe("protected-fixture")
          expect(await Bun.file(path.join(wsPath, "private", "secret")).text()).toBe("private-fixture")
          expect(await Bun.file(path.join(outside, "escaped")).exists()).toBe(false)
          expect(await Bun.file(sentinel).text()).toBe("host-only-fixture")
          const controlled = path.join(wsPath, ".synergy", "tmp", "sandbox-e2e-controlled")
          const isolated = path.join(wsPath, ".synergy", "tmp", path.relative("/tmp", sentinel))
          if (blocked) {
            expect(await Bun.file(controlled).exists()).toBe(false)
            expect(await Bun.file(isolated).exists()).toBe(false)
          } else {
            expect(await Bun.file(controlled).text()).toBe("controlled")
            expect(await Bun.file(isolated).text()).toBe("isolated")
          }
          await executor.release(id)
          await executor.releasePreparation(id)
          expect((await executor.inspectPreparation(id)).state).toBe("released")
        } finally {
          fs.rmSync(fixture, { recursive: true, force: true })
          fs.rmSync(outside, { recursive: true, force: true })
          fs.rmSync(hostTmp, { recursive: true, force: true })
        }
      }))
})

afterRuntimeTests(() => runtime.close())
