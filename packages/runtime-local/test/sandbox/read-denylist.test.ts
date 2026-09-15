import { describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { buildPermissionProfile } from "@ericsanchezok/synergy-harness/sandbox/policy-engine"
import { MacOSPolicy } from "../../src/sandbox/macos-policy"

// ---------------------------------------------------------------------------
// sandbox/read-denylist.test.ts
//
// Deny-list read model of the macOS deny-default backend: file reads are
// allowed globally and only credential-bearing locations stay denied.
// Write containment is unchanged — writes are denied everywhere except the
// parameterized writable roots. A deny containing the workspace stays in
// the profile: the deeper writable-root parameter allow wins under
// most-specific-match, so a workspace nested in a credential directory
// works while sibling credentials stay unreadable.
//
// Run with:
//   cd packages/runtime-local && bun test test/sandbox/read-denylist.test.ts
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
  test("readDenyPaths drop entries equal to or inside the workspace and writable roots", () => {
    const homedir = os.homedir()
    // A project rooted exactly at a credential path keeps its own files
    // readable — the deny entry for that path is excluded.
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
  })

  test("readDenyPaths keep the ancestor deny for a nested workspace (carve-out)", () => {
    const homedir = os.homedir()
    // A workspace nested under a credential directory keeps the ancestor
    // deny: the compiled writable-root parameter allow is deeper than the
    // subpath deny and wins under most-specific-match, so credential
    // siblings stay unreadable while the project itself works.
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
  })
})

describe("deny-default compiler read model", () => {
  test("global read allow, per-path read denies, and write params only", () => {
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
  })
})

describe("real sandbox-exec read deny-list behavior (darwin)", () => {
  test("host read allowed, denied path unreadable, host write blocked, workspace write allowed", () => {
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
      // Reads: the denied credential path stays unreadable — a subpath deny
      // is more specific than the bare global allow and wins.
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
  })

  test("nested workspace carves out of an ancestor credential deny", () => {
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
      // parameterized allow — most-specific-match beats the ancestor deny.
      expect(out).toContain("proj-read")
      expect(out).toContain("proj-write-ok")
      expect(fs.existsSync(path.join(ws, "w.txt"))).toBe(true)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
