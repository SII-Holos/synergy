import { describe, test, expect } from "bun:test"
import { checkProtectedPath } from "@/enforcement/classify"

describe("checkProtectedPath - write mode", () => {
  test("flags .git/", () => {
    const r = checkProtectedPath(".git/config", "write")
    expect(r.matched).toBe(true)
    expect(r.category).toBe("vcs")
  })

  test("flags nested .git/", () => {
    expect(checkProtectedPath("subdir/.git/HEAD", "write").matched).toBe(true)
  })

  test("flags .env", () => {
    const r = checkProtectedPath(".env", "write")
    expect(r.matched).toBe(true)
    expect(r.category).toBe("secrets")
  })

  test("flags .env.local", () => {
    expect(checkProtectedPath(".env.local", "write").matched).toBe(true)
  })

  test("flags .env.production", () => {
    expect(checkProtectedPath(".env.production", "write").matched).toBe(true)
  })

  test("flags .vscode/", () => {
    expect(checkProtectedPath(".vscode/settings.json", "write").matched).toBe(true)
  })

  test("flags .claude/", () => {
    expect(checkProtectedPath(".claude/settings.json", "write").matched).toBe(true)
  })

  test("flags .synergy/", () => {
    expect(checkProtectedPath(".synergy/config", "write").matched).toBe(true)
  })

  test("flags .husky/", () => {
    expect(checkProtectedPath(".husky/pre-commit", "write").matched).toBe(true)
  })

  test("flags .devcontainer/", () => {
    expect(checkProtectedPath(".devcontainer/devcontainer.json", "write").matched).toBe(true)
  })

  test("does NOT flag normal project paths", () => {
    expect(checkProtectedPath("src/index.ts", "write").matched).toBe(false)
    expect(checkProtectedPath("README.md", "write").matched).toBe(false)
    expect(checkProtectedPath("package.json", "write").matched).toBe(false)
  })
})

describe("checkProtectedPath - read mode", () => {
  test("flags ~/.ssh/", () => {
    const r = checkProtectedPath("~/.ssh/id_rsa", "read")
    expect(r.matched).toBe(true)
    expect(r.category).toBe("credentials")
  })

  test("flags .ssh/ in subpath", () => {
    expect(checkProtectedPath("home/user/.ssh/config", "read").matched).toBe(true)
  })

  test("flags .aws/", () => {
    expect(checkProtectedPath("~/.aws/credentials", "read").matched).toBe(true)
  })

  test("flags .config/git/", () => {
    expect(checkProtectedPath("~/.config/git/config", "read").matched).toBe(true)
  })

  test("flags id_rsa directly", () => {
    expect(checkProtectedPath("id_rsa", "read").matched).toBe(true)
  })

  test("flags id_ed25519", () => {
    expect(checkProtectedPath("id_ed25519", "read").matched).toBe(true)
  })

  test("flags .pem files", () => {
    expect(checkProtectedPath("cert.pem", "read").matched).toBe(true)
  })

  test("flags .key files", () => {
    expect(checkProtectedPath("private.key", "read").matched).toBe(true)
  })

  test("flags .p12 files", () => {
    expect(checkProtectedPath("cert.p12", "read").matched).toBe(true)
  })

  test("flags credentials file", () => {
    expect(checkProtectedPath("~/.aws/credentials", "read").matched).toBe(true)
  })

  test("does NOT flag normal reads", () => {
    expect(checkProtectedPath("src/index.ts", "read").matched).toBe(false)
    expect(checkProtectedPath("package.json", "read").matched).toBe(false)
    expect(checkProtectedPath("README.md", "read").matched).toBe(false)
  })
})

describe("checkProtectedPath - path normalization", () => {
  test("handles ./ prefix", () => {
    expect(checkProtectedPath("./.env", "write").matched).toBe(true)
  })

  test("handles ~/ prefix", () => {
    expect(checkProtectedPath("~/.ssh/config", "read").matched).toBe(true)
  })

  test("handles absolute paths", () => {
    expect(checkProtectedPath("/home/user/.ssh/id_rsa", "read").matched).toBe(true)
  })

  test("handles empty path", () => {
    expect(checkProtectedPath("", "write").matched).toBe(false)
    expect(checkProtectedPath("", "read").matched).toBe(false)
  })
})

describe("checkProtectedPath - secrets always protected (both modes)", () => {
  test(".env is protected in read mode too", () => {
    expect(checkProtectedPath(".env", "read").matched).toBe(true)
  })

  test(".pem is protected in write mode too", () => {
    expect(checkProtectedPath("cert.pem", "write").matched).toBe(true)
  })

  test("id_rsa is protected in write mode too", () => {
    expect(checkProtectedPath("id_rsa", "write").matched).toBe(true)
  })
})

describe("checkProtectedPath - worktree exclusion", () => {
  test("worktree paths are NOT flagged (absolute)", () => {
    const worktreePath = "/home/user/project/.synergy/worktrees/fix-123/src/index.ts"
    expect(checkProtectedPath(worktreePath, "write").matched).toBe(false)
  })

  test("worktree paths are NOT flagged (relative)", () => {
    const worktreePath = ".synergy/worktrees/fix-123/packages/synergy/src/index.ts"
    expect(checkProtectedPath(worktreePath, "write").matched).toBe(false)
  })

  test("worktree paths are NOT flagged (read mode)", () => {
    expect(checkProtectedPath(".synergy/worktrees/fix-123/src/main.ts", "read").matched).toBe(false)
  })

  test("non-worktree .synergy/ paths are STILL flagged", () => {
    expect(checkProtectedPath(".synergy/config", "write").matched).toBe(true)
    expect(checkProtectedPath(".synergy/synergy.d/00-general.jsonc", "write").matched).toBe(true)
    expect(checkProtectedPath("subdir/.synergy/data/profile.json", "write").matched).toBe(true)
  })

  test("worktree paths with config-like content are safe", () => {
    // A path like .synergy/worktrees/X/.synergy/config should NOT be flagged
    // because the worktree prefix takes priority
    expect(checkProtectedPath(".synergy/worktrees/fix-123/.synergy/config", "write").matched).toBe(false)
  })
})
