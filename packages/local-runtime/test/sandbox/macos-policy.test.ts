import { describe, test, expect } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { MacOSPolicy } from "../../src/sandbox/macos-policy"
import { compileGlobToSeatbeltRegex } from "../../src/sandbox/macos-policy"
import type { SynergySandboxPermissionProfile } from "@ericsanchezok/synergy-harness/sandbox/policy-engine"

// ---------------------------------------------------------------------------
// sandbox/macos-policy.test.ts
//
// Tests for macOS Seatbelt policy generation — glob → regex compilation
// and deny-read SBPL rules for unreadableGlobs.
//
// Run with:
//   cd packages/local-runtime && bun test test/sandbox/macos-policy.test.ts
// ---------------------------------------------------------------------------

// ------------------------------------------------------------------
// Helper: build a minimal profile for testing
// ------------------------------------------------------------------
function buildProfile(unreadableGlobs: string[] = []): SynergySandboxPermissionProfile {
  return {
    fileSystem: {
      readableRoots: ["/tmp"],
      writableRoots: ["/tmp/workspace"],
      readOnlySubpaths: [],
      unreadableGlobs,
      protectedMetadataNames: [],
      protectedPaths: [],
      dataDenyRoots: [],
      includePlatformDefaults: true,
      workspace: "/tmp/workspace",
    },
    network: {
      mode: "full",
      allowLocalBinding: true,
      allowedUnixSockets: [],
    },
  }
}

test.skipIf(process.platform !== "darwin")(
  "metadata ancestors do not deny workspace writes while nested metadata stays protected",
  () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "synergy-metadata-")))
    try {
      for (const ancestor of [".codex", ".agents"]) {
        const workspace = path.join(root, ancestor, 'work [1]+ *?{2} "空间"', "project")
        const extra = path.join(root, ancestor, "extra")
        const sibling = path.join(root, ancestor, "sibling")
        for (const directory of [workspace, extra, sibling]) fs.mkdirSync(directory, { recursive: true })
        const policy = buildProfile()
        policy.fileSystem.workspace = workspace
        policy.fileSystem.writableRoots = [workspace, extra]
        policy.fileSystem.protectedMetadataNames = [".agents", ".codex"]
        policy.network.mode = "restricted"
        const compiled = MacOSPolicy.compileExecution(policy)
        const filename = path.join(root, "profile.sb")
        fs.writeFileSync(filename, compiled.profile)
        const write = (target: string) =>
          Bun.spawnSync(
            [
              "/usr/bin/sandbox-exec",
              "-f",
              filename,
              ...Object.entries(compiled.params).flatMap(([key, value]) => ["-D", `${key}=${value}`]),
              "/bin/sh",
              "-c",
              'printf changed > "$1"',
              "probe",
              target,
            ],
            { stdout: "pipe", stderr: "pipe" },
          )
        for (const directory of [workspace, extra]) {
          const allowed = write(path.join(directory, "source.txt"))
          expect({ code: allowed.exitCode, stderr: allowed.stderr.toString() }).toEqual({ code: 0, stderr: "" })
          for (const metadata of [".agents", ".codex", "nested/.agents", "nested/.codex"]) {
            const target = path.join(directory, metadata, "config")
            fs.mkdirSync(path.dirname(target), { recursive: true })
            fs.writeFileSync(target, "original")
            expect(write(target).exitCode).not.toBe(0)
            expect(fs.readFileSync(target, "utf8")).toBe("original")
          }
          const ordinary = path.join(directory, "sub.codex", "source.txt")
          fs.mkdirSync(path.dirname(ordinary), { recursive: true })
          expect(write(ordinary).exitCode).toBe(0)
        }
        expect(write(path.join(sibling, "outside.txt")).exitCode).not.toBe(0)
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  },
)

// ------------------------------------------------------------------
// 1. Glob → Seatbelt regex compilation
// ------------------------------------------------------------------
describe("compileGlobToSeatbeltRegex", () => {
  test("*.log → matches /tmp/test.log", () => {
    const regex = compileGlobToSeatbeltRegex("*.log")
    const re = new RegExp(regex)
    expect(re.test("/tmp/test.log")).toBe(true)
  })

  test("*.log → matches /var/log/foo.log", () => {
    const regex = compileGlobToSeatbeltRegex("*.log")
    const re = new RegExp(regex)
    expect(re.test("/var/log/foo.log")).toBe(true)
  })

  test("*.log → does not match /tmp/test.txt", () => {
    const regex = compileGlobToSeatbeltRegex("*.log")
    const re = new RegExp(regex)
    expect(re.test("/tmp/test.txt")).toBe(false)
  })

  test("*.log → does not match /tmp/test.log/extra", () => {
    const regex = compileGlobToSeatbeltRegex("*.log")
    const re = new RegExp(regex)
    expect(re.test("/tmp/test.log/extra")).toBe(false)
  })
  test("*.log → matches /a/b.log (prefix absorbs leading dirs)", () => {
    const regex = compileGlobToSeatbeltRegex("*.log")
    const re = new RegExp(regex)
    expect(re.test("/a/b.log")).toBe(true)
  })
  test("**/node_modules/** → matches deep path", () => {
    const regex = compileGlobToSeatbeltRegex("**/node_modules/**")
    const re = new RegExp(regex)
    expect(re.test("/usr/lib/node_modules/pkg/index.js")).toBe(true)
  })

  test("**/node_modules/** → matches shallow path", () => {
    const regex = compileGlobToSeatbeltRegex("**/node_modules/**")
    const re = new RegExp(regex)
    expect(re.test("/node_modules/foo")).toBe(true)
  })

  test("**/*.tmp → matches /tmp/foo.tmp", () => {
    const regex = compileGlobToSeatbeltRegex("**/*.tmp")
    const re = new RegExp(regex)
    expect(re.test("/tmp/foo.tmp")).toBe(true)
  })

  test("**/*.tmp → matches deeper path", () => {
    const regex = compileGlobToSeatbeltRegex("**/*.tmp")
    const re = new RegExp(regex)
    expect(re.test("/a/b/c/x.tmp")).toBe(true)
  })

  test("**/*.tmp → does not match non-tmp files", () => {
    const regex = compileGlobToSeatbeltRegex("**/*.tmp")
    const re = new RegExp(regex)
    expect(re.test("/tmp/foo.txt")).toBe(false)
  })

  test("literal dots are escaped properly in *.log", () => {
    const regex = compileGlobToSeatbeltRegex("*.log")
    // Dot should be escaped in regex, not matching e.g. "xllog"
    const re = new RegExp(regex)
    expect(re.test("/tmp/testlog")).toBe(false)
    expect(re.test("/tmp/test.log")).toBe(true)
  })

  test("literal dots and plus signs are escaped", () => {
    const regex = compileGlobToSeatbeltRegex("config.+")
    const re = new RegExp(regex)
    expect(re.test("/foo/config.+")).toBe(true)
    expect(re.test("/foo/configx+")).toBe(false)
  })

  test("question mark matches single non-slash character", () => {
    const regex = compileGlobToSeatbeltRegex("file.??")
    const re = new RegExp(regex)
    expect(re.test("/tmp/file.js")).toBe(true)
    expect(re.test("/tmp/file.ts")).toBe(true)
    expect(re.test("/tmp/file.x")).toBe(false)
    expect(re.test("/tmp/file.txt")).toBe(false)
  })

  test("brace expansion {a,b} produces alternatives", () => {
    const regex = compileGlobToSeatbeltRegex("*.{js,ts}")
    const re = new RegExp(regex)
    expect(re.test("/src/app.js")).toBe(true)
    expect(re.test("/src/app.ts")).toBe(true)
    expect(re.test("/src/app.css")).toBe(false)
  })

  test("regex is anchored with ^ and $", () => {
    const regex = compileGlobToSeatbeltRegex("*.log")
    expect(regex).toStartWith("^")
    expect(regex).toEndWith("$")
  })
})

// ------------------------------------------------------------------
// 2. Profile compilation with unreadableGlobs
// ------------------------------------------------------------------
describe("compileProfile with unreadableGlobs", () => {
  test("no unreadableGlobs → no deny-read regex rules", () => {
    const profile = buildProfile([])
    const sbpl = MacOSPolicy.compileProfile(profile)
    expect(sbpl).not.toContain("(deny file-read* (regex")
    expect(sbpl).not.toContain("(deny file-read-data (regex")
  })

  test("single unreadableGlob → produces (deny file-read* ...) and (deny file-read-data ...)", () => {
    const profile = buildProfile(["*.log"])
    const sbpl = MacOSPolicy.compileProfile(profile)
    expect(sbpl).toContain("(deny file-read* (regex")
    expect(sbpl).toContain("(deny file-read-data (regex")
  })

  test("multiple unreadableGlobs → produces corresponding deny rules", () => {
    const profile = buildProfile(["*.log", "*.tmp"])
    const sbpl = MacOSPolicy.compileProfile(profile)
    // Count occurrences of deny file-read* (regex — each glob produces one)
    const readStarMatches = sbpl.match(/\(deny file-read\* \(regex/g)
    expect(readStarMatches).not.toBeNull()
    expect(readStarMatches!.length).toBe(2)
    // Count deny file-read-data
    const readDataMatches = sbpl.match(/\(deny file-read-data \(regex/g)
    expect(readDataMatches).not.toBeNull()
    expect(readDataMatches!.length).toBe(2)
  })

  test("glob deny rules appear after metadata rules", () => {
    const profile = buildProfile(["*.log"])
    const sbpl = MacOSPolicy.compileProfile(profile)
    const globIndex = sbpl.indexOf("(deny file-read* (regex")
    const metadataIndex = sbpl.indexOf("(deny file-read* (subpath")
    // If both exist, glob regex deny should appear after subpath denies
    if (metadataIndex !== -1) {
      expect(globIndex).toBeGreaterThan(metadataIndex)
    }
  })
})

// ------------------------------------------------------------------
// 3. Unix socket policy
// ------------------------------------------------------------------
describe("compileProfile with unix sockets", () => {
  test("no unix sockets → no unix socket rules", () => {
    const profile = buildProfile([])
    const sbpl = MacOSPolicy.compileProfile(profile)
    expect(sbpl).not.toContain("(allow system-socket")
  })

  test("single unix socket → produces (allow system-socket AF_UNIX) and file-read* file-write* rule", () => {
    const profile = buildProfile([])
    profile.network.allowedUnixSockets = ["/var/run/docker.sock"]
    const sbpl = MacOSPolicy.compileProfile(profile)
    expect(sbpl).toContain("(allow system-socket AF_UNIX)")
    expect(sbpl).toContain('(allow file-read* file-write* (subpath "/var/run/docker.sock"))')
  })

  test("multiple unix sockets → produces single AF_UNIX allow and multiple file rules", () => {
    const profile = buildProfile([])
    profile.network.allowedUnixSockets = ["/var/run/docker.sock", "/tmp/agent.sock"]
    const sbpl = MacOSPolicy.compileProfile(profile)
    // Only one AF_UNIX header
    const afMatches = sbpl.match(/\(allow system-socket AF_UNIX\)/g)
    expect(afMatches).not.toBeNull()
    expect(afMatches!.length).toBe(1)
    // Both paths present
    expect(sbpl).toContain('(allow file-read* file-write* (subpath "/var/run/docker.sock"))')
    expect(sbpl).toContain('(allow file-read* file-write* (subpath "/tmp/agent.sock"))')
  })
})

// ------------------------------------------------------------------
// 4. Path canonicalization for paths that do not exist yet
//
// The writable root is always bound through its canonical spelling, so a
// protected subpath deny must resolve aliases even when its final component
// does not exist — otherwise the deny and the allow use different spellings
// and never intersect, letting the deeper write allow win. A symlink alias
// reproduces the same divergence on any platform that macOS firmlinks cause
// with /var/folders and /tmp.
// ------------------------------------------------------------------
describe("compileProfile canonicalizes paths that do not exist yet", () => {
  test("non-existent protected subpath is denied in the same spelling as the writable root", () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "synergy-canon-")))
    const real = path.join(root, "real-workspace")
    fs.mkdirSync(real)
    const alias = path.join(root, "alias-workspace")
    fs.symlinkSync(real, alias)
    const protectedHooks = path.join(alias, ".git", "hooks")
    expect(fs.existsSync(protectedHooks)).toBe(false)

    try {
      const profile = buildProfile([])
      profile.fileSystem.writableRoots = [alias]
      profile.fileSystem.readOnlySubpaths = [protectedHooks, path.join(alias, ".git", "config")]

      // The allow is bound through the resolved path...
      expect(MacOSPolicy.generateParams(profile).PATH_WRITE_0).toBe(real)

      const sbpl = MacOSPolicy.compileProfile(profile)
      // ...so the deny must be emitted through that same resolved spelling for
      // the two rules to intersect.
      expect(sbpl).toContain(`(deny file-write* (subpath "${real}/.git/hooks"))`)
      expect(sbpl).not.toContain(`(subpath "${alias}/.git/hooks")`)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("existing paths and unresolvable paths keep their prior behavior", () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "synergy-canon-x-")))
    const real = path.join(root, "real-workspace")
    fs.mkdirSync(path.join(real, ".git", "hooks"), { recursive: true })
    const alias = path.join(root, "alias-workspace")
    fs.symlinkSync(real, alias)

    try {
      const profile = buildProfile([])
      profile.fileSystem.writableRoots = [alias]
      profile.fileSystem.readOnlySubpaths = [path.join(alias, ".git", "hooks")]

      const params = MacOSPolicy.generateParams(profile)
      expect(params.PATH_WRITE_0).toBe(real)
      expect(MacOSPolicy.compileProfile(profile)).toContain(`(deny file-write* (subpath "${real}/.git/hooks"))`)

      // A path with no existing ancestor is emitted verbatim rather than
      // dropped, so the rule set stays available to the kernel's own resolution.
      const orphan = buildProfile([])
      orphan.fileSystem.writableRoots = [alias]
      orphan.fileSystem.readOnlySubpaths = ["/nonexistent-synergy-root/.git/hooks"]
      expect(MacOSPolicy.compileProfile(orphan)).toContain(
        '(deny file-write* (subpath "/nonexistent-synergy-root/.git/hooks"))',
      )
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
