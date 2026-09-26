import { describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { buildPermissionProfile } from "@ericsanchezok/synergy-harness/sandbox/policy-engine"
import { MacOSPolicy } from "../../src/sandbox/macos-policy"
import { afterAll as afterRuntimeTests } from "bun:test"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()

// ---------------------------------------------------------------------------
// sandbox/read-denylist.test.ts
//
// Deny-list read model of the macOS deny-default backend: file reads are
// allowed globally and only credential-bearing locations stay denied.
// Write containment is unchanged — writes are denied everywhere except the
// parameterized writable roots. A deny is emitted on whichever side of the
// writable-root allow makes it effective, because Seatbelt applies the last
// matching rule rather than the most specific one: a deny containing the
// workspace is emitted first so the deeper allow wins, and a deny inside a
// writable root is emitted after it so the deny wins.
//
// Run with:
//   cd packages/local-runtime && bun test test/sandbox/read-denylist.test.ts
// ---------------------------------------------------------------------------

function profileFor(ws: string, readDenyPaths: string[]) {
  return {
    fileSystem: {
      readableRoots: [],
      writableRoots: [ws],
      readOnlySubpaths: [],
      unreadableGlobs: [],
      protectedMetadataNames: [],
      protectedPaths: [],
      dataDenyRoots: [],
      readDenyPaths,
      includePlatformDefaults: true,
      workspace: ws,
    },
    network: { mode: "restricted" as const, allowLocalBinding: false, allowedUnixSockets: [] },
  }
}

describe("policy-engine read deny scope", () => {
  test("readDenyPaths drop only a deny equal to the workspace", () =>
    runtime.run(() => {
      // A project rooted exactly at a credential path keeps its own files
      // readable — the deny entry for that path is excluded.
      const homedir = os.homedir()
      const ws = path.join(homedir, ".ssh")
      const p = buildPermissionProfile({
        workspace: ws,
        executionCwd: ws,
        sandboxMode: "workspace_write",
        approvedReadPaths: [],
        approvedWritePaths: [],
        approvedNetwork: false,
        approvedUnixSockets: [],
      })
      expect(p.fileSystem.readDenyPaths).not.toContain(ws)
      expect(p.fileSystem.readDenyPaths).toContain(path.join(homedir, ".aws"))
      expect(p.fileSystem.readDenyPaths).toContain(path.join(homedir, ".gnupg"))
    }))

  test("readDenyPaths keep the ancestor deny for a nested workspace (carve-out)", () =>
    runtime.run(() => {
      const homedir = os.homedir()
      // A workspace nested under a credential directory keeps the ancestor
      // deny: it is emitted before the writable-root allow, so the deeper
      // allow wins and the project itself works while credential siblings
      // stay unreadable.
      const ws = path.join(homedir, ".ssh", "proj")
      const p = buildPermissionProfile({
        workspace: ws,
        executionCwd: ws,
        sandboxMode: "workspace_write",
        approvedReadPaths: [],
        approvedWritePaths: [],
        approvedNetwork: false,
        approvedUnixSockets: [],
      })
      expect(p.fileSystem.readDenyPaths).toContain(path.join(homedir, ".ssh"))
      expect(p.fileSystem.readDenyPaths).toContain(path.join(homedir, ".aws"))
    }))
})

describe("deny-default compiler read model", () => {
  test("global read allow, per-path read denies, and write params only", () =>
    runtime.run(() => {
      const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "synergy-rdlc-")))
      try {
        const ws = path.join(root, "ws")
        const deny = path.join(root, "secret.txt")
        fs.mkdirSync(ws)
        fs.writeFileSync(deny, "s3cret\n")

        const profile = profileFor(ws, [deny])
        const sbpl = MacOSPolicy.compileProfile(profile)
        expect(sbpl).toContain("(allow file-read*)")
        expect(sbpl).toContain(`(deny file-read* (subpath "${deny}"))`)

        const params = MacOSPolicy.generateParams(profile)
        expect(Object.keys(params)).toEqual(["PATH_WRITE_0"])
        expect(params.PATH_WRITE_0).toBe(ws)
      } finally {
        fs.rmSync(root, { recursive: true, force: true })
      }
    }))
})

describe("real sandbox-exec read deny-list behavior (darwin)", () => {
  test("host read allowed, denied path unreadable, host write blocked, workspace write allowed", () =>
    runtime.run(() => {
      if (process.platform !== "darwin") return
      if (!fs.existsSync("/usr/bin/sandbox-exec")) return

      const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "synergy-rdl-")))
      try {
        const ws = path.join(root, "ws")
        const secret = path.join(root, "secret.txt")
        const plain = path.join(root, "plain.txt")
        const hostOut = path.join(root, "host-out.txt")
        fs.mkdirSync(ws)
        fs.writeFileSync(secret, "s3cret\n")
        fs.writeFileSync(plain, "plain\n")

        const profile = profileFor(ws, [secret])
        const sbpl = MacOSPolicy.compileProfile(profile)
        const params = MacOSPolicy.generateParams(profile)
        const sbPath = path.join(root, "probe.sb")
        fs.writeFileSync(sbPath, sbpl)
        const dArgs = Object.entries(params).flatMap(([k, v]) => ["-D", `${k}=${v}`])

        const q = (p: string) => JSON.stringify(p)
        const cmd = [
          `test -r ${q(plain)} && echo plain-ok`,
          `cat ${q(secret)} >/dev/null 2>&1 && echo secret-read || echo secret-blocked`,
          `echo x > ${q(path.join(ws, "w.txt"))} && echo ws-write-ok`,
          `echo x > ${q(hostOut)} 2>/dev/null && echo host-write-ok || echo host-write-blocked`,
        ].join("; ")

        const proc = Bun.spawnSync(["sandbox-exec", "-f", sbPath, ...dArgs, "/bin/sh", "-c", cmd], {
          stdout: "pipe",
          stderr: "pipe",
        })
        const out = proc.stdout.toString()
        // Reads: ordinary host file readable through the global allow.
        expect(out).toContain("plain-ok")
        // Reads: the denied credential path stays unreadable — the subpath deny
        // is emitted before the writable-root allow, so it survives it.
        expect(out).toContain("secret-blocked")
        expect(out).not.toContain("secret-read")
        // Writes: workspace writable root works.
        expect(out).toContain("ws-write-ok")
        expect(fs.existsSync(path.join(ws, "w.txt"))).toBe(true)
        // Writes: host paths outside the writable roots stay blocked.
        expect(out).toContain("host-write-blocked")
        expect(fs.existsSync(hostOut)).toBe(false)
      } finally {
        fs.rmSync(root, { recursive: true, force: true })
      }
    }))

  test("nested workspace carves out of an ancestor credential deny", () =>
    runtime.run(() => {
      if (process.platform !== "darwin") return
      if (!fs.existsSync("/usr/bin/sandbox-exec")) return

      const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "synergy-rdlx-")))
      try {
        const creds = path.join(root, "creds")
        const ws = path.join(creds, "proj")
        const siblingKey = path.join(creds, "id_rsa")
        const projFile = path.join(ws, "existing.txt")
        fs.mkdirSync(ws, { recursive: true })
        fs.writeFileSync(siblingKey, "PRIVATE\n")
        fs.writeFileSync(projFile, "data\n")

        // The ancestor credential directory is denied; the workspace nested
        // inside it is the writable root.
        const profile = profileFor(ws, [creds])
        const sbpl = MacOSPolicy.compileProfile(profile)
        const params = MacOSPolicy.generateParams(profile)
        const sbPath = path.join(root, "probe.sb")
        fs.writeFileSync(sbPath, sbpl)
        const dArgs = Object.entries(params).flatMap(([k, v]) => ["-D", `${k}=${v}`])

        const q = (p: string) => JSON.stringify(p)
        const cmd = [
          `cat ${q(siblingKey)} >/dev/null 2>&1 && echo sibling-read || echo sibling-blocked`,
          `cat ${q(projFile)} >/dev/null 2>&1 && echo proj-read || echo proj-blocked`,
          `echo x > ${q(path.join(ws, "w.txt"))} && echo proj-write-ok`,
        ].join("; ")

        const proc = Bun.spawnSync(["sandbox-exec", "-f", sbPath, ...dArgs, "/bin/sh", "-c", cmd], {
          stdout: "pipe",
          stderr: "pipe",
        })
        const out = proc.stdout.toString()
        // The ancestor deny stays effective for sibling credentials.
        expect(out).toContain("sibling-blocked")
        expect(out).not.toContain("sibling-read")
        // The nested workspace is readable and writable through its deeper
        // parameterized allow because the ancestor deny is emitted first.
        expect(out).toContain("proj-read")
        expect(out).toContain("proj-write-ok")
        expect(fs.existsSync(path.join(ws, "w.txt"))).toBe(true)
      } finally {
        fs.rmSync(root, { recursive: true, force: true })
      }
    }))

  test("a workspace rooted at a deny home keeps its credential denies effective", () =>
    runtime.run(() => {
      if (process.platform !== "darwin") return
      if (!fs.existsSync("/usr/bin/sandbox-exec")) return

      const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "synergy-rdlh-")))
      const owner = RuntimeContext.create({
        home: root,
        root: path.join(root, ".synergy"),
        env: { ...runtime.host.env, SYNERGY_HOME: root, SYNERGY_TEST_HOME: root },
      })
      try {
        owner.run(() => {
          // The Scope directory IS a read-deny home, so the credential denies
          // derived from it sit inside the writable root. Pruning those is what
          // left the global read allow unopposed for ~/.ssh and the runtime auth
          // store; keeping them without ordering them after the writable allow
          // would leave them just as ineffective.
          const keys = path.join(root, ".ssh")
          const auth = path.join(root, ".synergy", "data", "auth")
          fs.mkdirSync(keys, { recursive: true })
          fs.mkdirSync(auth, { recursive: true })
          const keyFile = path.join(keys, "id_rsa")
          const authFile = path.join(auth, "token.json")
          const plain = path.join(root, "workspace.txt")
          fs.writeFileSync(keyFile, "PRIVATE\n")
          fs.writeFileSync(authFile, '{"token":"s3cret"}\n')
          fs.writeFileSync(plain, "data\n")

          const profile = buildPermissionProfile({
            workspace: root,
            executionCwd: root,
            sandboxMode: "workspace_write",
            approvedReadPaths: [],
            approvedWritePaths: [],
            approvedNetwork: false,
            approvedUnixSockets: [],
          })
          expect(profile.fileSystem.readDenyPaths).toContain(keys)
          expect(profile.fileSystem.readDenyPaths).toContain(auth)

          const sbPath = path.join(root, "probe.sb")
          fs.writeFileSync(sbPath, MacOSPolicy.compileProfile(profile))
          const params = MacOSPolicy.generateParams(profile)
          const dArgs = Object.entries(params).flatMap(([k, v]) => ["-D", `${k}=${v}`])

          const q = (p: string) => JSON.stringify(p)
          const cmd = [
            // Readability only — the probe never reads credential content.
            `test -r ${q(keyFile)} && echo key-readable || echo key-blocked`,
            `test -r ${q(authFile)} && echo auth-readable || echo auth-blocked`,
            // The workspace's own non-secret files must stay readable.
            `test -r ${q(plain)} && echo ws-ok`,
          ].join("; ")

          const proc = Bun.spawnSync(["sandbox-exec", "-f", sbPath, ...dArgs, "/bin/sh", "-c", cmd], {
            stdout: "pipe",
            stderr: "pipe",
          })
          const out = proc.stdout.toString()
          expect(out).toContain("key-blocked")
          expect(out).not.toContain("key-readable")
          expect(out).toContain("auth-blocked")
          expect(out).not.toContain("auth-readable")
          expect(out).toContain("ws-ok")
        })
      } finally {
        owner.dispose()
        fs.rmSync(root, { recursive: true, force: true })
      }
    }))
})

afterRuntimeTests(() => runtime.close())
