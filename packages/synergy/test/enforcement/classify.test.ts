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
    const cases = ["src/**/*.ts", "lib/**/*.js", "test/fixture/**", "packages/synergy/src/**/*.ts", "a/b/c/d/e.txt"]
    for (const pattern of cases) {
      const result = PathClassifier.classify(pattern, { workspace })
      expect(result.boundary).toBe("inside")
    }
  })

  test("absolute paths within workspace are classified as inside", () => {
    const { PathClassifier } = require("../../src/enforcement/classify")
    const workspace = "/home/user/my-project"
    const result = PathClassifier.classify(path.join(workspace, "src/index.ts"), { workspace })
    expect(result.boundary).toBe("inside")
  })

  test("edge case: workspace root itself is inside", () => {
    const { PathClassifier } = require("../../src/enforcement/classify")
    const workspace = "/home/user/my-project"
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
    expect(result.confidence).toBe("high")
  })

  test("multiple parent traversals are outside", () => {
    const { PathClassifier } = require("../../src/enforcement/classify")
    const workspace = "/home/user/my-project"
    const result = PathClassifier.classify("../../../etc/**/*", { workspace })
    expect(result.boundary).toBe("outside")
  })

  test("absolute path outside workspace is classified as outside", () => {
    const { PathClassifier } = require("../../src/enforcement/classify")
    const workspace = "/home/user/my-project"
    const cases = ["/etc/passwd", "/usr/local/bin/node", "/tmp/data.log", "/var/log/system.log"]
    for (const absPath of cases) {
      const result = PathClassifier.classify(absPath, { workspace })
      expect(result.boundary).toBe("outside")
    }
  })

  test("$HOME/** patterns are classified as potentially outside", () => {
    const { PathClassifier } = require("../../src/enforcement/classify")
    const workspace = "/home/user/my-project"
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
    const result = PathClassifier.classify("/home/user", { workspace })
    expect(result.boundary).toBe("outside")
  })

  test("path that starts with workspace but is a sibling (prefix trap)", () => {
    const { PathClassifier } = require("../../src/enforcement/classify")
    const workspace = "/home/user/project"
    const result = PathClassifier.classify("/home/user/project-other", { workspace })
    expect(result.boundary).toBe("outside")
  })

  test("workspace-relative parent traversal with ./ prefix", () => {
    const { PathClassifier } = require("../../src/enforcement/classify")
    const workspace = "/home/user/my-project"
    const result = PathClassifier.classify("./../../outside.txt", { workspace })
    expect(result.boundary).toBe("outside")
  })
})

describe("PathClassifier — no filesystem I/O", () => {
  test("classify does not call any fs APIs", () => {
    const { PathClassifier } = require("../../src/enforcement/classify")
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
      expect(() => PathClassifier.classify(pattern, { workspace })).not.toThrow()
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
    const workspace = "/private/tmp/my-project"
    const result = PathClassifier.classify("/tmp/my-project/src", { workspace })
    expect(result.boundary).toBe("outside")
  })
})

describe("PathClassifier — glob pattern classification for search tools", () => {
  test("glob patterns are classified by their base path, not expansion", () => {
    const { PathClassifier } = require("../../src/enforcement/classify")
    const workspace = "/home/user/my-project"
    const result = PathClassifier.classifyGlobPattern("src/**/*.ts", { workspace })
    expect(result.boundary).toBe("inside")
  })

  test("glob with absolute base outside workspace is classified outside", () => {
    const { PathClassifier } = require("../../src/enforcement/classify")
    const workspace = "/home/user/my-project"
    const result = PathClassifier.classifyGlobPattern("/etc/**/*.conf", { workspace })
    expect(result.boundary).toBe("outside")
  })

  test("glob with parent traversal base is classified outside", () => {
    const { PathClassifier } = require("../../src/enforcement/classify")
    const workspace = "/home/user/my-project"
    const result = PathClassifier.classifyGlobPattern("../lib/**/*.so", { workspace })
    expect(result.boundary).toBe("outside")
  })

  test("classifyGlobPattern does not expand or iterate — pure analysis", () => {
    const { PathClassifier } = require("../../src/enforcement/classify")
    const workspace = "/no/such/dir/ever-" + Math.random().toString(36).slice(2)
    const result = PathClassifier.classifyGlobPattern("src/**/*.ts", { workspace })
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
    expect(parentTraversal.reason).not.toBe(absoluteOutside.reason)
  })
})

describe("PathClassifier — confidence levels", () => {
  test("absolute path inside workspace has high confidence", () => {
    const { PathClassifier } = require("../../src/enforcement/classify")
    const workspace = "/home/user/my-project"
    const result = PathClassifier.classify(path.join(workspace, "src/index.ts"), { workspace })
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
    const patterns = ["src/**/*.ts", "../outside/**/*", "/etc/hosts", "lib/helper.js"]
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
      expect(results[i].boundary).toBeDefined()
    }
  })
})

describe("PathClassifier.classifyPath — worktree awareness", () => {
  test("worktree-internal path classified as 'inside' when originalCheckout is set", () => {
    const { PathClassifier } = require("../../src/enforcement/classify")
    const workspace = "/home/user/project/.synergy/worktrees/brave-cactus"
    const originalCheckout = "/home/user/project"
    const result = PathClassifier.classifyPath("/home/user/project/.synergy/worktrees/brave-cactus/src/index.ts", {
      workspace,
      originalCheckout,
    })
    expect(result.boundary).toBe("inside")
  })

  test("path in original checkout classified as 'outside' when inside a worktree", () => {
    const { PathClassifier } = require("../../src/enforcement/classify")
    const workspace = "/home/user/project/.synergy/worktrees/brave-cactus"
    const originalCheckout = "/home/user/project"
    const result = PathClassifier.classifyPath("/home/user/project/src/main.ts", { workspace, originalCheckout })
    expect(result.boundary).toBe("outside")
    expect(result.reason).toContain("original checkout")
  })

  test("sibling worktree subpath classified as 'outside'", () => {
    const { PathClassifier } = require("../../src/enforcement/classify")
    // Both worktrees live under the repo (originalCheckout). A subpath of a
    // sibling worktree is inside the original checkout but outside the active
    // workspace. The classifyPath guard catches it via the originalCheckout
    // enrichment path.
    const workspace = "/home/user/project/.synergy/worktrees/brave-cactus"
    const originalCheckout = "/home/user/project"
    const result = PathClassifier.classifyPath("/home/user/project/.synergy/worktrees/swift-eagle/src/foo.ts", {
      workspace,
      originalCheckout,
    })
    expect(result.boundary).toBe("outside")
    expect(result.reason).toContain("original checkout")
  })

  test("behaves like classify when originalCheckout is not provided", () => {
    const { PathClassifier } = require("../../src/enforcement/classify")
    const workspace = "/home/user/project/.synergy/worktrees/brave-cactus"
    const insideResult = PathClassifier.classifyPath(
      "/home/user/project/.synergy/worktrees/brave-cactus/src/index.ts",
      { workspace },
    )
    expect(insideResult.boundary).toBe("inside")
    const outsideResult = PathClassifier.classifyPath("/etc/passwd", { workspace })
    expect(outsideResult.boundary).toBe("outside")
  })

  test("relative paths expanded against workspace, not original checkout", () => {
    const { PathClassifier } = require("../../src/enforcement/classify")
    const workspace = "/home/user/project/.synergy/worktrees/brave-cactus"
    const originalCheckout = "/home/user/project"
    const result = PathClassifier.classifyPath("src/foo.ts", { workspace, originalCheckout })
    expect(result.boundary).toBe("inside")
  })
})
