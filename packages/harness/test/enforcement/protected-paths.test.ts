import { describe, test, expect } from "bun:test"
import { checkProtectedPath } from "../../src/enforcement/classify"
import path from "node:path"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()

describe("checkProtectedPath - write mode", () => {
  test("flags .git/", () =>
    runtime.run(() => {
      const r = checkProtectedPath(".git/config", "write")
      expect(r.matched).toBe(true)
      expect(r.category).toBe("vcs")
    }))

  test("flags nested .git/", () =>
    runtime.run(() => {
      expect(checkProtectedPath("subdir/.git/HEAD", "write").matched).toBe(true)
    }))

  test("flags .env", () =>
    runtime.run(() => {
      const r = checkProtectedPath(".env", "write")
      expect(r.matched).toBe(true)
      expect(r.category).toBe("secrets")
    }))

  test("flags .env.local", () =>
    runtime.run(() => {
      expect(checkProtectedPath(".env.local", "write").matched).toBe(true)
    }))

  test("flags .env.production", () =>
    runtime.run(() => {
      expect(checkProtectedPath(".env.production", "write").matched).toBe(true)
    }))

  test("does not flag editor or assistant config directories as sensitive paths", () =>
    runtime.run(() => {
      expect(checkProtectedPath(".vscode/settings.json", "write").matched).toBe(false)
      expect(checkProtectedPath(".claude/settings.json", "write").matched).toBe(false)
    }))

  test("does not flag project .synergy non-secret paths", () =>
    runtime.run(() => {
      expect(checkProtectedPath(".synergy/config", "write", { workspaceRoot: "/workspace" }).matched).toBe(false)
      expect(
        checkProtectedPath(".synergy/synergy.d/00-general.jsonc", "write", { workspaceRoot: "/workspace" }).matched,
      ).toBe(false)
    }))

  test("does not flag non-secret project config directories as sensitive paths", () =>
    runtime.run(() => {
      expect(checkProtectedPath(".husky/pre-commit", "write").matched).toBe(false)
      expect(checkProtectedPath(".devcontainer/devcontainer.json", "write").matched).toBe(false)
    }))

  test("does NOT flag normal project paths", () =>
    runtime.run(() => {
      expect(checkProtectedPath("src/index.ts", "write").matched).toBe(false)
      expect(checkProtectedPath("README.md", "write").matched).toBe(false)
      expect(checkProtectedPath("package.json", "write").matched).toBe(false)
    }))
})

describe("checkProtectedPath - read mode", () => {
  test("flags ~/.ssh/", () =>
    runtime.run(() => {
      const r = checkProtectedPath("~/.ssh/id_rsa", "read")
      expect(r.matched).toBe(true)
      expect(r.category).toBe("credentials")
    }))

  test("flags .ssh/ in subpath", () =>
    runtime.run(() => {
      expect(checkProtectedPath("home/user/.ssh/config", "read").matched).toBe(true)
    }))

  test("flags .aws/", () =>
    runtime.run(() => {
      expect(checkProtectedPath("~/.aws/credentials", "read").matched).toBe(true)
    }))

  test("flags .config/git/", () =>
    runtime.run(() => {
      expect(checkProtectedPath("~/.config/git/config", "read").matched).toBe(true)
    }))

  test("flags id_rsa directly", () =>
    runtime.run(() => {
      expect(checkProtectedPath("id_rsa", "read").matched).toBe(true)
    }))

  test("flags id_ed25519", () =>
    runtime.run(() => {
      expect(checkProtectedPath("id_ed25519", "read").matched).toBe(true)
    }))

  test("flags .pem files", () =>
    runtime.run(() => {
      expect(checkProtectedPath("cert.pem", "read").matched).toBe(true)
    }))

  test("flags .key files", () =>
    runtime.run(() => {
      expect(checkProtectedPath("private.key", "read").matched).toBe(true)
    }))

  test("flags .p12 files", () =>
    runtime.run(() => {
      expect(checkProtectedPath("cert.p12", "read").matched).toBe(true)
    }))

  test("flags credentials file", () =>
    runtime.run(() => {
      expect(checkProtectedPath("~/.aws/credentials", "read").matched).toBe(true)
    }))

  test("does NOT flag normal reads", () =>
    runtime.run(() => {
      expect(checkProtectedPath("src/index.ts", "read").matched).toBe(false)
      expect(checkProtectedPath("package.json", "read").matched).toBe(false)
      expect(checkProtectedPath("README.md", "read").matched).toBe(false)
    }))
})

describe("checkProtectedPath - path normalization", () => {
  test("handles ./ prefix", () =>
    runtime.run(() => {
      expect(checkProtectedPath("./.env", "write").matched).toBe(true)
    }))

  test("handles ~/ prefix", () =>
    runtime.run(() => {
      expect(checkProtectedPath("~/.ssh/config", "read").matched).toBe(true)
    }))

  test("handles absolute paths", () =>
    runtime.run(() => {
      expect(checkProtectedPath("/home/user/.ssh/id_rsa", "read").matched).toBe(true)
    }))

  test("handles empty path", () =>
    runtime.run(() => {
      expect(checkProtectedPath("", "write").matched).toBe(false)
      expect(checkProtectedPath("", "read").matched).toBe(false)
    }))
})

describe("checkProtectedPath - secrets always protected (both modes)", () => {
  test(".env is protected in read mode too", () =>
    runtime.run(() => {
      expect(checkProtectedPath(".env", "read").matched).toBe(true)
    }))

  test(".pem is protected in write mode too", () =>
    runtime.run(() => {
      expect(checkProtectedPath("cert.pem", "write").matched).toBe(true)
    }))

  test("id_rsa is protected in write mode too", () =>
    runtime.run(() => {
      expect(checkProtectedPath("id_rsa", "write").matched).toBe(true)
    }))
})

describe("checkProtectedPath - worktree exclusion", () => {
  test("worktree paths are NOT flagged (absolute)", () =>
    runtime.run(() => {
      const worktreePath = "/home/user/project/.synergy/worktrees/fix-123/src/index.ts"
      expect(checkProtectedPath(worktreePath, "write").matched).toBe(false)
    }))

  test("worktree paths are NOT flagged (relative)", () =>
    runtime.run(() => {
      const worktreePath = ".synergy/worktrees/fix-123/packages/harness/src/index.ts"
      expect(checkProtectedPath(worktreePath, "write").matched).toBe(false)
    }))

  test("worktree paths are NOT flagged (read mode)", () =>
    runtime.run(() => {
      expect(checkProtectedPath(".synergy/worktrees/fix-123/src/main.ts", "read").matched).toBe(false)
    }))

  test("non-worktree .synergy non-secret paths are not flagged", () =>
    runtime.run(() => {
      expect(checkProtectedPath(".synergy/config", "write", { workspaceRoot: "/workspace" }).matched).toBe(false)
      expect(
        checkProtectedPath(".synergy/synergy.d/00-general.jsonc", "write", { workspaceRoot: "/workspace" }).matched,
      ).toBe(false)
      expect(
        checkProtectedPath("subdir/.synergy/data/profile.json", "write", { workspaceRoot: "/workspace" }).matched,
      ).toBe(false)
    }))

  test("worktree paths with config-like content are safe", () =>
    runtime.run(() => {
      // A path like .synergy/worktrees/X/.synergy/config should NOT be flagged
      // because the worktree prefix takes priority
      expect(checkProtectedPath(".synergy/worktrees/fix-123/.synergy/config", "write").matched).toBe(false)
    }))
})

describe("checkProtectedPath - Synergy auth and dotenv candidates", () => {
  test("global Synergy auth root is an exact secret root", () =>
    runtime.run(() => {
      const r = checkProtectedPath("/home/user/.synergy/data/auth/provider-auth.json", "read", {
        workspaceRoot: "/workspace",
        synergyRoot: "/home/user/.synergy",
      })
      expect(r.matched).toBe(true)
      expect(r.category).toBe("credentials")
      expect(r.exactSecretRoot).toBe(true)
    }))

  test("plugin auth file is an exact secret root", () =>
    runtime.run(() => {
      const r = checkProtectedPath("/home/user/.synergy/data/plugin/demo/auth.json", "write", {
        workspaceRoot: "/workspace",
        synergyRoot: "/home/user/.synergy",
      })
      expect(r.matched).toBe(true)
      expect(r.exactSecretRoot).toBe(true)
    }))

  test("dotenv examples are SmartAllow-eligible candidates", () =>
    runtime.run(() => {
      const r = checkProtectedPath(".env.example", "write", { workspaceRoot: "/workspace" })
      expect(r.matched).toBe(true)
      expect(r.category).toBe("secrets")
      expect(r.smartAllowEligible).toBe(true)
      expect(r.exactSecretRoot).toBe(false)
    }))

  test(".envrc is not a dotenv secret path", () =>
    runtime.run(() => {
      expect(checkProtectedPath(".envrc", "write", { workspaceRoot: "/workspace" }).matched).toBe(false)
    }))

  const home = runtime.host.home

  test("global Synergy auth root via ~/ is an exact secret root", () =>
    runtime.run(() => {
      const r = checkProtectedPath("~/.synergy/data/auth/provider-auth.json", "read", {
        workspaceRoot: "/workspace",
        synergyRoot: path.join(home, ".synergy"),
      })
      expect(r.matched).toBe(true)
      expect(r.category).toBe("credentials")
      expect(r.exactSecretRoot).toBe(true)
    }))

  test("plugin auth file via ~/ is an exact secret root", () =>
    runtime.run(() => {
      const r = checkProtectedPath("~/.synergy/data/plugin/my-plugin/auth.json", "write", {
        workspaceRoot: "/workspace",
        synergyRoot: path.join(home, ".synergy"),
      })
      expect(r.matched).toBe(true)
      expect(r.exactSecretRoot).toBe(true)
    }))
})

afterRuntimeTests(() => runtime.close())
