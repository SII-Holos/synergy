import { describe, test, expect } from "bun:test"
import { MacOSPolicy } from "../../src/sandbox/macos-policy"
import { compileGlobToSeatbeltRegex } from "../../src/sandbox/macos-policy"
import type { SynergySandboxPermissionProfile } from "../../src/sandbox/policy-engine"

// ---------------------------------------------------------------------------
// sandbox/macos-policy.test.ts
//
// Tests for macOS Seatbelt policy generation — glob → regex compilation
// and deny-read SBPL rules for unreadableGlobs.
//
// Run with:
//   cd packages/synergy && bun test test/sandbox/macos-policy.test.ts
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
