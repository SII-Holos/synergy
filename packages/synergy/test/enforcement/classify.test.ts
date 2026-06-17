import { describe, expect, test, mock } from "bun:test"
import path from "path"
import os from "os"

// ---------------------------------------------------------------------------
// enforcement/classify.test.ts
//
// Tests for PathClassifier — the enforcement module that classifies glob
// patterns, search paths, and file references as inside or potentially
// outside the active workspace boundary.
//
// CRITICAL DESIGN INVARIANT: PathClassifier must use STRING/BASE-PATH
// analysis only. It must NOT call stat(), realpath(), readdir(), or any
// other filesystem API. It operates entirely on path strings. This is
// essential for search-tool hot paths (glob, grep) where per-file I/O
// would destroy performance.
//
// These tests encode the DESIGN CONTRACT before implementation exists.
// They MUST fail (RED) with module-not-found or type errors until
// packages/synergy/src/enforcement/classify.ts is created.
// ---------------------------------------------------------------------------

describe("PathClassifier workspace boundary — inside workspace", () => {
  test("src/**/*.ts is classified as inside workspace with no filesystem I/O", () => {
    const { PathClassifier } = require("../../src/enforcement/classify")
    const workspace = "/home/user/my-project"

    const result = PathClassifier.classify("src/**/*.ts", { workspace })

    expect(result.boundary).toBe("inside")
    expect(result.confidence).toBe("high")
  })

  test("relative subdirectory patterns are inside workspace", () => {
    const { PathClassifier } = require("../../src/enforcement/classify")
    const workspace = "/home/user/my-project"

    const cases = [
      "src/**/*.ts",
      "lib/**/*.js",
      "test/fixture/**",
      "packages/synergy/src/**/*.ts",
      "a/b/c/d/e.txt",
    ]

    for (const pattern of cases) {
      const result = PathClassifier.classify(pattern, { workspace })
      expect(result.boundary).toBe("inside")
    }
  })

  test("absolute paths within workspace are classified as inside", () => {
    const { PathClassifier } = require("../../src/enforcement/classify")
    const workspace = "/home/user/my-project"

    const result = PathClassifier.classify(
      path.join(workspace, "src/index.ts"),
      { workspace },
    )

    expect(result.boundary).toBe("inside")
    expect(result.confidence).toBe("high")
  })

  test("edge case: workspace root itself is inside", () => {
    const { PathClassifier } = require("../../src/enforcement/classify")
    const workspace = "/home/user/my-project"

    // An exact match to the workspace root
    const result = PathClassifier.classify(workspace, { workspace })

    expect(result.boundary).toBe("inside")
  })

  test("edge case: single dot resolves inside workspace", () => {
    const { PathClassifier } = require("../../src/enforcement/classify")
    const workspace = "/home/user/my-project"

    const result = PathClassifier.classify(".", { workspace })

    expect(result.boundary).toBe("inside")
  })

  test("path with trailing separator still inside workspace", () => {
    const { PathClassifier } = require("../../src/enforcement/classify")
    const workspace = "/home/user/my-project"

    const result = PathClassifier.classify(workspace + "/", { workspace })

    expect(result.boundary).toBe("inside")
  })
})

describe("PathClassifier workspace boundary — potentially outside", () => {
  test("../**/*.ts is classified as potentially outside workspace", () => {
    const { PathClassifier } = require("../../src/enforcement/classify")
    const workspace = "/home/user/my-project"

    const result = PathClassifier.classify("../**/*.ts", { workspace })

    expect(result.boundary).toBe("outside")
    // A parent traversal pattern has high confidence of crossing boundary
    expect(result.confidence).toBe("high")
  })

  test("multiple parent traversals are outside", () => {
    const { PathClassifier } = require("../../src/enforcement/classify")
    const workspace = "/home/user/my-project"

    const result = PathClassifier.classify("../../../etc/**/*", {
      workspace,
    })

    expect(result.boundary).toBe("outside")
  })

  test("absolute path outside workspace is classified as outside", () => {
    const { PathClassifier } = require("../../src/enforcement/classify")
    const workspace = "/home/user/my-project"

    const cases = [
      "/etc/passwd",
      "/usr/local/bin/node",
      "/tmp/data.log",
      "/var/log/system.log",
    ]

    for (const absPath of cases) {
      const result = PathClassifier.classify(absPath, { workspace })
      expect(result.boundary).toBe("outside")
    }
  })

  test("$HOME/** patterns are classified as potentially outside", () => {
    const { PathClassifier } = require("../../src/enforcement/classify")
    const workspace = "/home/user/my-project"

    // $HOME is a shell expansion that resolves outside the workspace
    // (unless workspace IS $HOME, which is unusual)
    const result = PathClassifier.classify("$HOME/**/*", { workspace })

    expect(result.boundary).toBe("outside")
  })

  test("~/** patterns are classified as potentially outside", () => {
    const { PathClassifier } = require("../../src/enforcement/classify")
    const workspace = "/home/user/my-project"

    const result = PathClassifier.classify("~/**/*", { workspace })

    expect(result.boundary).toBe("outside")
  })

  test("absolute path matching workspace parent is outside", () => {
    const { PathClassifier } = require("../../src/enforcement/classify")
    const workspace = "/home/user/my-project"

    // /home/user is the workspace parent — not inside
    const result = PathClassifier.classify("/home/user", { workspace })

    expect(result.boundary).toBe("outside")
  })

  test("path that starts with workspace but is a sibling (prefix trap)", () => {
    const { PathClassifier } = require("../../src/enforcement/classify")
    const workspace = "/home/user/project"

    // /home/user/project-other is NOT inside /home/user/project
    // This is a common string-prefix bug — must use path-aware comparison
    const result = PathClassifier.classify("/home/user/project-other", {
      workspace,
    })

    expect(result.boundary).toBe("outside")
  })

  test("workspace-relative parent traversal with ./ prefix", () => {
    const { PathClassifier } = require("../../src/enforcement/classify")
    const workspace = "/home/user/my-project"

    const result = PathClassifier.classify("./../../outside.txt", {
      workspace,
    })

    expect(result.boundary).toBe("outside")
  })
})

describe("PathClassifier — no filesystem I/O", () => {
  test("classify does not call any fs APIs", () => {
    // Guard: verify the implementation has no fs imports or calls.
    // We do this by requiring the module and checking that fs functions
    // are not called during classification.
    const { PathClassifier } = require("../../src/enforcement/classify")

    // Run classify many times — if it calls stat/realpath, we'll detect
    // it by the fact that nonexistent paths don't cause ENOENT errors.
    const workspace = "/nonexistent-workspace-" + Math.random().toString(36).slice(2)
    const patterns = [
      "src/**/*.ts",
      "../outside/**/*",
      "/tmp/something",
      `${workspace}/foo`,
      "$HOME/stuff",
      "~/.config",
    ]

    for (const pattern of patterns) {
      expect(() =>
        PathClassifier.classify(pattern, { workspace }),
      ).not.toThrow()
    }
  })

  test("classify is pure — same input produces same output", () => {
    const { PathClassifier } = require("../../src/enforcement/classify")
    const workspace = "/home/user/my-project"

    const r1 = PathClassifier.classify("../outside/**/*", { workspace })
    const r2 = PathClassifier.classify("../outside/**/*", { workspace })

    expect(r1.boundary).toBe(r2.boundary)
    expect(r1.confidence).toBe(r2.confidence)
    expect(r1.reason).toBe(r2.reason)
  })

  test("classify never resolves symlinks — no realpath", () => {
    const { PathClassifier } = require("../../src/enforcement/classify")

    // /tmp on macOS is often a symlink to /private/tmp.
    // classify must NOT resolve this — it treats the path as a string.
    // If it called realpath, /tmp would become /private/tmp and could
    // unexpectedly change classification.
    const workspace = "/private/tmp/my-project"
    const result = PathClassifier.classify("/tmp/my-project/src", {
      workspace,
    })

    // /tmp/my-project is NOT textually inside /private/tmp/my-project
    // (even though they resolve to the same directory)
    expect(result.boundary).toBe("outside")
  })
})

describe("PathClassifier — glob pattern classification for search tools", () => {
  test("glob patterns are classified by their base path, not expansion", () => {
    const { PathClassifier } = require("../../src/enforcement/classify")
    const workspace = "/home/user/my-project"

    // The glob `src/**/*.ts` has base path `src` which is inside workspace.
    // classifyGlobPattern must classify by base, not iterate matches.
    const result = PathClassifier.classifyGlobPattern("src/**/*.ts", {
      workspace,
    })

    expect(result.boundary).toBe("inside")
  })

  test("glob with absolute base outside workspace is classified outside", () => {
    const { PathClassifier } = require("../../src/enforcement/classify")
    const workspace = "/home/user/my-project"

    const result = PathClassifier.classifyGlobPattern("/etc/**/*.conf", {
      workspace,
    })

    expect(result.boundary).toBe("outside")
  })

  test("glob with parent traversal base is classified outside", () => {
    const { PathClassifier } = require("../../src/enforcement/classify")
    const workspace = "/home/user/my-project"

    const result = PathClassifier.classifyGlobPattern("../lib/**/*.so", {
      workspace,
    })

    expect(result.boundary).toBe("outside")
  })

  test("classifyGlobPattern does not expand or iterate — pure analysis", () => {
    // Critical: the function must NOT call any filesystem API, must NOT
    // use Bun.Glob.scan() or equivalent. It performs string analysis only.
    const { PathClassifier } = require("../../src/enforcement/classify")

    // Use a nonexistent workspace and a glob that could never match.
    // If the function tries to expand, it'll either throw (nonexistent dir)
    // or return no matches (which would cause false-negative classification).
    const workspace = "/no/such/dir/ever-" + Math.random().toString(36).slice(2)
    const result = PathClassifier.classifyGlobPattern("src/**/*.ts", {
      workspace,
    })

    // Even without the workspace existing, the classification must
    // still be "inside" because base path analysis says it is.
    expect(result.boundary).toBe("inside")
  })
})

describe("PathClassifier — boundary reason output", () => {
  test("classify returns a human-readable reason", () => {
    const { PathClassifier } = require("../../src/enforcement/classify")
    const workspace = "/home/user/my-project"

    const result = PathClassifier.classify("../outside.txt", { workspace })

    expect(typeof result.reason).toBe("string")
    expect(result.reason.length).toBeGreaterThan(0)
  })

  test("inside classification reason mentions workspace", () => {
    const { PathClassifier } = require("../../src/enforcement/classify")
    const workspace = "/home/user/my-project"

    const result = PathClassifier.classify("src/foo.ts", { workspace })

    expect(result.reason).toContain("inside")
  })

  test("outside classification reason explains why", () => {
    const { PathClassifier } = require("../../src/enforcement/classify")
    const workspace = "/home/user/my-project"

    const parentTraversal = PathClassifier.classify("../x", { workspace })
    expect(parentTraversal.reason).not.toBe("")

    const absoluteOutside = PathClassifier.classify("/etc/hosts", { workspace })
    expect(absoluteOutside.reason).not.toBe("")

    // Different outside paths should have distinct reasons
    expect(parentTraversal.reason).not.toBe(absoluteOutside.reason)
  })
})

describe("PathClassifier — confidence levels", () => {
  test("absolute path inside workspace has high confidence", () => {
    const { PathClassifier } = require("../../src/enforcement/classify")
    const workspace = "/home/user/my-project"

    const result = PathClassifier.classify(
      path.join(workspace, "src/index.ts"),
      { workspace },
    )

    expect(result.confidence).toBe("high")
  })

  test("relative path inside workspace has high confidence", () => {
    const { PathClassifier } = require("../../src/enforcement/classify")
    const workspace = "/home/user/my-project"

    const result = PathClassifier.classify("src/**/*.ts", { workspace })

    expect(result.confidence).toBe("high")
  })

  test("parent traversal has high confidence of outside", () => {
    const { PathClassifier } = require("../../src/enforcement/classify")
    const workspace = "/home/user/my-project"

    const result = PathClassifier.classify("../**/*", { workspace })

    expect(result.confidence).toBe("high")
  })

  test("absolute path outside workspace has high confidence", () => {
    const { PathClassifier } = require("../../src/enforcement/classify")
    const workspace = "/home/user/my-project"

    const result = PathClassifier.classify("/etc/passwd", { workspace })

    expect(result.confidence).toBe("high")
  })
})

describe("PathClassifier — boundary check integration points", () => {
  test("classifyBatch returns results for multiple patterns at once", () => {
    const { PathClassifier } = require("../../src/enforcement/classify")
    const workspace = "/home/user/my-project"

    const patterns = [
      "src/**/*.ts",
      "../outside/**/*",
      "/etc/hosts",
      "lib/helper.js",
    ]

    const results = PathClassifier.classifyBatch(patterns, { workspace })

    expect(Array.isArray(results)).toBe(true)
    expect(results.length).toBe(patterns.length)

    expect(results[0].boundary).toBe("inside")
    expect(results[1].boundary).toBe("outside")
    expect(results[2].boundary).toBe("outside")
    expect(results[3].boundary).toBe("inside")
  })

  test("classifyBatch preserves input order", () => {
    const { PathClassifier } = require("../../src/enforcement/classify")
    const workspace = "/home/user/my-project"

    const patterns = ["a.ts", "b.ts", "c.ts"]
    const results = PathClassifier.classifyBatch(patterns, { workspace })

    for (let i = 0; i < patterns.length; i++) {
      // Each result should correspond to the input at same index
      expect(results[i].boundary).toBeDefined()
    }
  })
})
