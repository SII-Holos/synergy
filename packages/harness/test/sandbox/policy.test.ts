import { describe, test, expect } from "bun:test"
import { ReadDenyMatcher, isMetadataWriteDenied, PROTECTED_METADATA_PATH_NAMES } from "../../src/sandbox/policy"
import * as path from "path"
// ---------------------------------------------------------------------------
// sandbox/policy.test.ts
//
// Tests for runtime ReadDenyMatcher — glob compilation, isDenied matching,
// isDeniedBatch filtering, and fail-closed behavior.
//
// Run with:
//   cd packages/synergy && bun test test/sandbox/policy.test.ts
// ---------------------------------------------------------------------------

// ------------------------------------------------------------------
// 1. Glob → RegExp compilation (via ReadDenyMatcher behavior)
// ------------------------------------------------------------------
describe("glob pattern matching", () => {
  test("*.log → matches /tmp/test.log", () => {
    const m = new ReadDenyMatcher(["*.log"], [])
    expect(m.isDenied("/tmp/test.log")).toBe(true)
  })

  test("*.log → matches /var/log/foo.log", () => {
    const m = new ReadDenyMatcher(["*.log"], [])
    expect(m.isDenied("/var/log/foo.log")).toBe(true)
  })

  test("*.log → does not match /tmp/test.txt", () => {
    const m = new ReadDenyMatcher(["*.log"], [])
    expect(m.isDenied("/tmp/test.txt")).toBe(false)
  })

  test("*.log → does not match /tmp/test.log/extra", () => {
    const m = new ReadDenyMatcher(["*.log"], [])
    expect(m.isDenied("/tmp/test.log/extra")).toBe(false)
  })

  test("*.log → matches /a/b.log (prefix absorbs leading dirs)", () => {
    const m = new ReadDenyMatcher(["*.log"], [])
    expect(m.isDenied("/a/b.log")).toBe(true)
  })

  test("**/node_modules/** → matches deep path", () => {
    const m = new ReadDenyMatcher(["**/node_modules/**"], [])
    expect(m.isDenied("/usr/lib/node_modules/pkg/index.js")).toBe(true)
  })

  test("**/node_modules/** → matches shallow path", () => {
    const m = new ReadDenyMatcher(["**/node_modules/**"], [])
    expect(m.isDenied("/node_modules/foo")).toBe(true)
  })

  test("**/*.tmp → matches /tmp/foo.tmp", () => {
    const m = new ReadDenyMatcher(["**/*.tmp"], [])
    expect(m.isDenied("/tmp/foo.tmp")).toBe(true)
  })

  test("**/*.tmp → matches deeper path", () => {
    const m = new ReadDenyMatcher(["**/*.tmp"], [])
    expect(m.isDenied("/a/b/c/x.tmp")).toBe(true)
  })

  test("**/*.tmp → does not match non-tmp files", () => {
    const m = new ReadDenyMatcher(["**/*.tmp"], [])
    expect(m.isDenied("/tmp/foo.txt")).toBe(false)
  })

  test("literal dots are escaped — *.log does not match testlog", () => {
    const m = new ReadDenyMatcher(["*.log"], [])
    expect(m.isDenied("/tmp/testlog")).toBe(false)
    expect(m.isDenied("/tmp/test.log")).toBe(true)
  })

  test("brace expansion {js,ts} produces alternatives", () => {
    const m = new ReadDenyMatcher(["*.{js,ts}"], [])
    expect(m.isDenied("/src/app.js")).toBe(true)
    expect(m.isDenied("/src/app.ts")).toBe(true)
    expect(m.isDenied("/src/app.css")).toBe(false)
  })

  test("question mark matches single non-slash character", () => {
    const m = new ReadDenyMatcher(["file.??"], [])
    expect(m.isDenied("/tmp/file.js")).toBe(true)
    expect(m.isDenied("/tmp/file.ts")).toBe(true)
    expect(m.isDenied("/tmp/file.x")).toBe(false)
    expect(m.isDenied("/tmp/file.txt")).toBe(false)
  })
})

// ------------------------------------------------------------------
// 2. Exact path matching (unreadableRoots)
// ------------------------------------------------------------------
describe("exact path matching", () => {
  test("exact root match is denied", () => {
    const m = new ReadDenyMatcher([], ["/etc/passwd"])
    expect(m.isDenied("/etc/passwd")).toBe(true)
  })

  test("non-matching path is allowed", () => {
    const m = new ReadDenyMatcher([], ["/etc/passwd"])
    expect(m.isDenied("/etc/hosts")).toBe(false)
  })

  test("subpath of denied root is allowed when only root is denied", () => {
    const m = new ReadDenyMatcher([], ["/secret"])
    expect(m.isDenied("/secret")).toBe(true)
    expect(m.isDenied("/secret/file.txt")).toBe(false)
  })
})

// ------------------------------------------------------------------
// 3. Combined glob + exact matching
// ------------------------------------------------------------------
describe("combined matching", () => {
  test("both globs and roots deny independently", () => {
    const m = new ReadDenyMatcher(["*.log"], ["/etc/passwd"])
    expect(m.isDenied("/tmp/app.log")).toBe(true)
    expect(m.isDenied("/etc/passwd")).toBe(true)
    expect(m.isDenied("/tmp/data.txt")).toBe(false)
    expect(m.isDenied("/etc/hosts")).toBe(false)
  })

  test("path matched by both glob and root is denied (idempotent)", () => {
    const m = new ReadDenyMatcher(["*.log"], ["/tmp/error.log"])
    expect(m.isDenied("/tmp/error.log")).toBe(true)
  })
})

// ------------------------------------------------------------------
// 4. Empty inputs
// ------------------------------------------------------------------
describe("empty inputs", () => {
  test("no globs and no roots → nothing denied", () => {
    const m = new ReadDenyMatcher([], [])
    expect(m.isDenied("/anything")).toBe(false)
    expect(m.isDenied("/tmp/test.log")).toBe(false)
  })

  test("empty unreadableGlobs but has roots → roots still apply", () => {
    const m = new ReadDenyMatcher([], ["/secret"])
    expect(m.isDenied("/secret")).toBe(true)
    expect(m.isDenied("/other")).toBe(false)
  })

  test("empty unreadableRoots but has globs → globs still apply", () => {
    const m = new ReadDenyMatcher(["*.env"], [])
    expect(m.isDenied("/tmp/.env")).toBe(true)
  })
})

// ------------------------------------------------------------------
// 5. Fail-closed behavior
describe("fail-closed", () => {
  test("unbalanced brace is treated as literal, only matches exact", () => {
    const m = new ReadDenyMatcher(["unbalanced{"], [])
    // Does NOT match normal paths
    expect(m.isDenied("/anything")).toBe(false)
    // DOES match the literal glob text in a path component
    expect(m.isDenied("/tmp/unbalanced{")).toBe(true)
  })

  test("backslash glob compiles to literal backslash match", () => {
    const m = new ReadDenyMatcher(["\\"], [])
    expect(m.isDenied("/anything")).toBe(false)
  })
})

// ------------------------------------------------------------------
// 6. isDeniedBatch
// ------------------------------------------------------------------
describe("isDeniedBatch", () => {
  test("returns only denied paths", () => {
    const m = new ReadDenyMatcher(["*.log"], ["/etc/passwd"])
    const denied = m.isDeniedBatch(["/tmp/app.js", "/tmp/app.log", "/etc/passwd", "/usr/local/bin"])
    expect(denied).toEqual(["/tmp/app.log", "/etc/passwd"])
  })

  test("empty array returns empty", () => {
    const m = new ReadDenyMatcher(["*.log"], [])
    expect(m.isDeniedBatch([])).toEqual([])
  })

  test("unbalanced brace is treated as literal — batch returns only exact matches", () => {
    const m = new ReadDenyMatcher(["unbalanced{"], [])
    const result = m.isDeniedBatch(["/a", "/b", "/c", "/tmp/unbalanced{"])
    expect(result).toEqual(["/tmp/unbalanced{"])
  })
})

// ------------------------------------------------------------------
// 7. Complex real-world patterns
// ------------------------------------------------------------------
describe("real-world patterns", () => {
  test("**/node_modules/** blocks nested node_modules", () => {
    const m = new ReadDenyMatcher(["**/node_modules/**"], [])
    expect(m.isDenied("/project/node_modules/foo.js")).toBe(true)
    expect(m.isDenied("/project/packages/a/node_modules/bar.js")).toBe(true)
    expect(m.isDenied("/project/src/index.ts")).toBe(false)
  })

  test("*.env blocks all env files", () => {
    const m = new ReadDenyMatcher(["*.env", "*.env.*"], [])
    expect(m.isDenied("/project/.env")).toBe(true)
    expect(m.isDenied("/project/.env.local")).toBe(true)
    expect(m.isDenied("/project/.env.production")).toBe(true)
    expect(m.isDenied("/project/package.json")).toBe(false)
  })

  test("**/.git/** blocks .git directory contents", () => {
    const m = new ReadDenyMatcher(["**/.git/**"], [])
    expect(m.isDenied("/workspace/.git/config")).toBe(true)
    expect(m.isDenied("/workspace/.git/HEAD")).toBe(true)
    expect(m.isDenied("/workspace/.gitignore")).toBe(false)
  })

  test("multiple patterns work together", () => {
    const m = new ReadDenyMatcher(["**/node_modules/**", "*.log", "**/.git/**"], [])
    expect(m.isDenied("/project/node_modules/react/index.js")).toBe(true)
    expect(m.isDenied("/project/error.log")).toBe(true)
    expect(m.isDenied("/project/.git/objects/abc")).toBe(true)
    expect(m.isDenied("/project/src/main.ts")).toBe(false)
    expect(m.isDenied("/project/readme.md")).toBe(false)
  })
})
// ------------------------------------------------------------------
// 8. isMetadataWriteDenied — policy-layer metadata write intercept
// ------------------------------------------------------------------
describe("isMetadataWriteDenied", () => {
  const writableRoots = ["/workspace"]

  test("denies write to /workspace/.git exactly", () => {
    const result = isMetadataWriteDenied(writableRoots, "/workspace/.git")
    expect(result.denied).toBe(true)
    if (result.denied) {
      expect(result.metadataName).toBe(".git")
      expect(result.path).toBe("/workspace/.git")
    }
  })

  test("denies write to /workspace/.git/config (subpath)", () => {
    const result = isMetadataWriteDenied(writableRoots, "/workspace/.git/config")
    expect(result.denied).toBe(true)
    if (result.denied) {
      expect(result.metadataName).toBe(".git")
    }
  })

  test("denies write to /workspace/.git/objects/00/abc123 (deep subpath)", () => {
    const result = isMetadataWriteDenied(writableRoots, "/workspace/.git/objects/00/abc123")
    expect(result.denied).toBe(true)
    if (result.denied) {
      expect(result.metadataName).toBe(".git")
    }
  })

  test("denies write to /workspace/.codex", () => {
    const result = isMetadataWriteDenied(writableRoots, "/workspace/.codex")
    expect(result.denied).toBe(true)
    if (result.denied) {
      expect(result.metadataName).toBe(".codex")
    }
  })

  test("allows write to /workspace/.synergy/data", () => {
    const result = isMetadataWriteDenied(writableRoots, "/workspace/.synergy/data")
    expect(result.denied).toBe(false)
  })

  test("denies write to /workspace/.agents/config", () => {
    const result = isMetadataWriteDenied(writableRoots, "/workspace/.agents/config")
    expect(result.denied).toBe(true)
    if (result.denied) {
      expect(result.metadataName).toBe(".agents")
    }
  })

  test("allows write to /workspace/src/main.ts (not protected)", () => {
    const result = isMetadataWriteDenied(writableRoots, "/workspace/src/main.ts")
    expect(result.denied).toBe(false)
  })

  test("allows write to /workspace/.gitignore (not a protected name)", () => {
    const result = isMetadataWriteDenied(writableRoots, "/workspace/.gitignore")
    expect(result.denied).toBe(false)
  })

  test("allows write to a file with protected prefix but not under root e.g. /other/.git", () => {
    const result = isMetadataWriteDenied(writableRoots, "/other/.git")
    expect(result.denied).toBe(false)
  })

  test("PATH traversal: /workspace/foo/../.git is denied when normalized", () => {
    const normalized = path.normalize("/workspace/foo/../.git")
    const result = isMetadataWriteDenied(writableRoots, normalized)
    expect(result.denied).toBe(true)
    if (result.denied) {
      expect(result.metadataName).toBe(".git")
    }
  })

  test("empty writableRoots → always not denied", () => {
    const result = isMetadataWriteDenied([], "/workspace/.git")
    expect(result.denied).toBe(false)
  })

  test("custom protected names via explicit parameter", () => {
    const custom = [".env", "secrets"]
    const result = isMetadataWriteDenied(["/workspace"], "/workspace/.env/prod", custom)
    expect(result.denied).toBe(true)
    if (result.denied) {
      expect(result.metadataName).toBe(".env")
    }
  })

  test("custom protected names: non-matching path allowed", () => {
    const custom = [".env", "secrets"]
    const result = isMetadataWriteDenied(["/workspace"], "/workspace/.git/config", custom)
    expect(result.denied).toBe(false)
  })

  test("targetPath exactly matches a writable root (not denied)", () => {
    const result = isMetadataWriteDenied(["/workspace"], "/workspace")
    expect(result.denied).toBe(false)
  })

  test("PROTECTED_METADATA_PATH_NAMES default constant matches expected values", () => {
    expect(PROTECTED_METADATA_PATH_NAMES).toEqual([".git", ".agents", ".codex"])
  })
})
