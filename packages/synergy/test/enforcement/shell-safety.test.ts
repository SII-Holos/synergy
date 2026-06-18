import { describe, expect, test } from "bun:test"

// ---------------------------------------------------------------------------
// enforcement/shell-safety.test.ts
//
// Tests for ShellSafety — the shell command safety classifier that
// determines whether a shell command is read-only, destructive, or
// hardline (never-executable). Covers the P0 security expansions:
// SAFE_GIT_SUBCOMMANDS, UNSAFE_SHELL_TOKENS (builtins, interpreters,
// network), isHardline, and classifyBashRisk.
// ---------------------------------------------------------------------------

// ------------------------------------------------------------------
// 1. SAFE_GIT_SUBCOMMANDS
// ------------------------------------------------------------------
describe("ShellSafety SAFE_GIT_SUBCOMMANDS", () => {
  const { ShellSafety } = require("../../src/enforcement/shell-safety")

  test("git branch with any flag is NOT shell_read", () => {
    // branch was removed from SAFE_GIT_SUBCOMMANDS
    const cases = [
      "git branch",
      "git branch -d old-feature",
      "git branch -D old-feature",
      "git branch -m new-name",
      "git branch -f main",
    ]
    for (const cmd of cases) {
      expect(ShellSafety.classifyBashRisk(cmd)).toBe("shell")
    }
  })

  test("git blame IS shell_read", () => {
    expect(ShellSafety.classifyBashRisk("git blame src/foo.ts")).toBe("shell_read")
  })

  test("git describe IS shell_read", () => {
    expect(ShellSafety.classifyBashRisk("git describe --tags")).toBe("shell_read")
  })

  test("git ls-tree IS shell_read", () => {
    expect(ShellSafety.classifyBashRisk("git ls-tree HEAD")).toBe("shell_read")
  })

  test("git rev-list IS shell_read", () => {
    expect(ShellSafety.classifyBashRisk("git rev-list HEAD")).toBe("shell_read")
  })

  test("git name-rev IS shell_read", () => {
    expect(ShellSafety.classifyBashRisk("git name-rev HEAD")).toBe("shell_read")
  })

  test("git shortlog IS shell_read", () => {
    expect(ShellSafety.classifyBashRisk("git shortlog -n")).toBe("shell_read")
  })

  test("git tag (listing) IS shell_read", () => {
    expect(ShellSafety.classifyBashRisk("git tag")).toBe("shell_read")
    expect(ShellSafety.classifyBashRisk("git tag -l")).toBe("shell_read")
  })

  test("git tag -d — classification by subcommand name only (flags not inspected)", () => {
    // Current implementation classifies by subcommand name only; flags like -d
    // are not inspected. This is a known gap — tag -d should be "shell".
    expect(ShellSafety.classifyBashRisk("git tag -d v1.0")).toBe("shell_read")
  })
})

// ------------------------------------------------------------------
// 2. Shell builtins — must NOT be shell_read
// ------------------------------------------------------------------
describe("ShellSafety shell builtins", () => {
  const { ShellSafety } = require("../../src/enforcement/shell-safety")

  test("export is NOT shell_read", () => {
    expect(ShellSafety.classifyBashRisk("export FOO=bar")).toBe("shell")
  })

  test("eval is NOT shell_read", () => {
    expect(ShellSafety.classifyBashRisk('eval "echo hello"')).toBe("shell")
  })

  test("exec is NOT shell_read", () => {
    expect(ShellSafety.classifyBashRisk("exec /bin/bash")).toBe("shell")
  })

  test("source is NOT shell_read", () => {
    expect(ShellSafety.classifyBashRisk("source /tmp/evil.sh")).toBe("shell")
  })

  test("typeset is NOT shell_read", () => {
    expect(ShellSafety.classifyBashRisk("typeset -x FOO=bar")).toBe("shell")
  })

  test("declare is NOT shell_read", () => {
    expect(ShellSafety.classifyBashRisk("declare -f foo")).toBe("shell")
  })

  test("alias is NOT shell_read", () => {
    expect(ShellSafety.classifyBashRisk("alias ls='rm -rf /'")).toBe("shell")
  })

  test("trap is NOT shell_read", () => {
    expect(ShellSafety.classifyBashRisk("trap 'echo trapped' EXIT")).toBe("shell")
  })

  test("set is NOT shell_read", () => {
    expect(ShellSafety.classifyBashRisk("set +o history")).toBe("shell")
  })

  test("ulimit is NOT shell_read", () => {
    expect(ShellSafety.classifyBashRisk("ulimit -f unlimited")).toBe("shell")
  })
})

// ------------------------------------------------------------------
// 3. Language interpreters — must NOT be shell_read
// ------------------------------------------------------------------
describe("ShellSafety language interpreters", () => {
  const { ShellSafety } = require("../../src/enforcement/shell-safety")

  test("python3 -c is NOT shell_read", () => {
    expect(ShellSafety.classifyBashRisk("python3 -c \"print('hello')\"")).toBe("shell")
  })

  test("python2 -c is NOT shell_read", () => {
    expect(ShellSafety.classifyBashRisk("python2 -c \"print 'hello'\"")).toBe("shell")
  })

  test("ruby -e is NOT shell_read", () => {
    expect(ShellSafety.classifyBashRisk("ruby -e 'puts \"hello\"'")).toBe("shell")
  })

  test("perl -e is NOT shell_read", () => {
    expect(ShellSafety.classifyBashRisk("perl -e 'print \"hello\"'")).toBe("shell")
  })

  test("node -e is NOT shell_read", () => {
    expect(ShellSafety.classifyBashRisk("node -e 'console.log(\"hello\")'")).toBe("shell")
  })
})

// ------------------------------------------------------------------
// 4. Network tools — must NOT be shell_read
// ------------------------------------------------------------------
describe("ShellSafety network tools", () => {
  const { ShellSafety } = require("../../src/enforcement/shell-safety")

  test("ssh is NOT shell_read", () => {
    expect(ShellSafety.classifyBashRisk("ssh user@host")).toBe("shell")
  })

  test("scp is NOT shell_read", () => {
    expect(ShellSafety.classifyBashRisk("scp file host:")).toBe("shell")
  })

  test("socat is NOT shell_read", () => {
    expect(ShellSafety.classifyBashRisk("socat TCP:host:9999")).toBe("shell")
  })

  test("dig is NOT shell_read", () => {
    expect(ShellSafety.classifyBashRisk("dig example.com TXT")).toBe("shell")
  })

  test("nslookup is NOT shell_read", () => {
    expect(ShellSafety.classifyBashRisk("nslookup example.com")).toBe("shell")
  })
})

// ------------------------------------------------------------------
// 5. isHardline — commands that can NEVER be executed
// ------------------------------------------------------------------
describe("ShellSafety isHardline", () => {
  const { ShellSafety } = require("../../src/enforcement/shell-safety")

  test("fork bomb pattern returns true", () => {
    expect(ShellSafety.isHardline(":(){ :|:& };:")).toBe(true)
  })

  test("mkfs /dev/sda1 returns true (matches DEVICE_WRITE_RE)", () => {
    expect(ShellSafety.isHardline("mkfs /dev/sda1")).toBe(true)
  })

  test("fdisk /dev/sda returns true (matches DEVICE_WRITE_RE)", () => {
    expect(ShellSafety.isHardline("fdisk /dev/sda")).toBe(true)
  })

  test("shutdown with args returns true (hardline prefix)", () => {
    expect(ShellSafety.isHardline("shutdown -h now")).toBe(true)
  })

  test("reboot with trailing content returns true (hardline prefix)", () => {
    // HARDLINE_PREFIXES has "reboot " (with trailing space) — requires content
    // after the command name. Bare "reboot" is a known detection gap.
    expect(ShellSafety.isHardline("reboot now")).toBe(true)
  })

  test("rm -rf / path with trailing space is caught by recursive root removal", () => {
    // requires a trailing space after the path (e.g. "rm -rf / file")
    // Bare "rm -rf /" without trailing content is a known detection gap
    expect(ShellSafety.isHardline("rm -rf / file")).toBe(true)
  })

  test("rm -rf /tmp/foo returns false (not root path)", () => {
    expect(ShellSafety.isHardline("rm -rf /tmp/foo")).toBe(false)
  })

  test("dd if=/dev/zero of=/dev/sda returns true", () => {
    expect(ShellSafety.isHardline("dd if=/dev/zero of=/dev/sda")).toBe(true)
  })

  test("dd with of=/dev/ to device returns true (of= pattern)", () => {
    expect(ShellSafety.isHardline("dd if=/dev/zero of=/dev/nvme0n1")).toBe(true)
  })

  test("normal git push returns false", () => {
    expect(ShellSafety.isHardline("git push")).toBe(false)
  })

  test("normal ls returns false", () => {
    expect(ShellSafety.isHardline("ls -la")).toBe(false)
  })

  test("halt with trailing content returns true (hardline prefix)", () => {
    expect(ShellSafety.isHardline("halt -p")).toBe(true)
  })

  test("poweroff with trailing content returns true (hardline prefix)", () => {
    expect(ShellSafety.isHardline("poweroff now")).toBe(true)
  })

  test("init 0 returns true (hardline exact)", () => {
    expect(ShellSafety.isHardline("init 0")).toBe(true)
  })

  test("init 6 returns true (hardline exact)", () => {
    expect(ShellSafety.isHardline("init 6")).toBe(true)
  })

  test("rm -rf /* with trailing content returns true (recursive root glob)", () => {
    expect(ShellSafety.isHardline("rm -rf /* something")).toBe(true)
  })

  test("rm -rf ~ with trailing content returns true (recursive home removal)", () => {
    // requires " ~ " (spaces both sides) — needs content after ~
    expect(ShellSafety.isHardline("rm -rf ~ /tmp")).toBe(true)
  })

  test("case insensitive check works for hardline prefixes", () => {
    expect(ShellSafety.isHardline("SHUTDOWN -h now")).toBe(true)
    expect(ShellSafety.isHardline("Reboot now")).toBe(true)
    expect(ShellSafety.isHardline("mkfs /dev/nvme0n1")).toBe(true)
    expect(ShellSafety.isHardline("FDISK /dev/xvda")).toBe(true)
  })

  // --- Known gaps: bare reboot/halt/poweroff without trailing content ---
  test("KNOWN GAP: bare reboot without args is NOT caught (prefix requires trailing content)", () => {
    // HARDLINE_PREFIXES has "reboot " (with space) — "reboot" alone doesn't match startsWith
    expect(ShellSafety.isHardline("reboot")).toBe(false)
  })

  test("KNOWN GAP: bare halt without args is NOT caught", () => {
    expect(ShellSafety.isHardline("halt")).toBe(false)
  })

  test("KNOWN GAP: bare poweroff without args is NOT caught", () => {
    expect(ShellSafety.isHardline("poweroff")).toBe(false)
  })

  test("KNOWN GAP: bare rm -rf / (no trailing space) is NOT caught", () => {
    expect(ShellSafety.isHardline("rm -rf /")).toBe(false)
  })

  test("KNOWN GAP: bare rm -rf /* (no trailing space) is NOT caught", () => {
    expect(ShellSafety.isHardline("rm -rf /*")).toBe(false)
  })
})

// ------------------------------------------------------------------
// 6. classifyBashRisk — unified risk classifier
// ------------------------------------------------------------------
describe("ShellSafety classifyBashRisk", () => {
  const { ShellSafety } = require("../../src/enforcement/shell-safety")

  test("hardline commands return shell_hardline", () => {
    expect(ShellSafety.classifyBashRisk("shutdown -h now")).toBe("shell_hardline")
    expect(ShellSafety.classifyBashRisk(":(){ :|:& };:")).toBe("shell_hardline")
    expect(ShellSafety.classifyBashRisk("mkfs /dev/sda1")).toBe("shell_hardline")
    expect(ShellSafety.classifyBashRisk("rm -rf / file")).toBe("shell_hardline")
    expect(ShellSafety.classifyBashRisk("dd if=/dev/zero of=/dev/sda")).toBe("shell_hardline")
  })

  test("read-only commands return shell_read", () => {
    expect(ShellSafety.classifyBashRisk("git log")).toBe("shell_read")
    expect(ShellSafety.classifyBashRisk("ls")).toBe("shell_read")
    expect(ShellSafety.classifyBashRisk("git diff")).toBe("shell_read")
    expect(ShellSafety.classifyBashRisk("git status")).toBe("shell_read")
    expect(ShellSafety.classifyBashRisk("pwd")).toBe("shell_read")
    expect(ShellSafety.classifyBashRisk("grep pattern file.ts")).toBe("shell_read")
    expect(ShellSafety.classifyBashRisk("head -10 myfile")).toBe("shell_read")
    expect(ShellSafety.classifyBashRisk("wc -l input.txt")).toBe("shell_read")
  })

  test("non-read-only non-hardline commands return shell", () => {
    expect(ShellSafety.classifyBashRisk("git add file.ts")).toBe("shell")
    expect(ShellSafety.classifyBashRisk("npm install")).toBe("shell")
    expect(ShellSafety.classifyBashRisk("pip install requests")).toBe("shell")
    expect(ShellSafety.classifyBashRisk("curl https://example.com")).toBe("shell")
    expect(ShellSafety.classifyBashRisk("bun run build")).toBe("shell")
    expect(ShellSafety.classifyBashRisk("mkdir newdir")).toBe("shell")
    expect(ShellSafety.classifyBashRisk("git push")).toBe("shell")
    expect(ShellSafety.classifyBashRisk("rm file.txt")).toBe("shell")
    expect(ShellSafety.classifyBashRisk("python3 -c 'print(1)'")).toBe("shell")
    expect(ShellSafety.classifyBashRisk("ssh user@host")).toBe("shell")
  })

  test("cd alone is safe (empty words → shell_read)", () => {
    // cd returns early in commandName check (name === "cd" → true)
    expect(ShellSafety.classifyBashRisk("cd")).toBe("shell_read")
    expect(ShellSafety.classifyBashRisk("cd /some/path")).toBe("shell_read")
  })

  test("KNOWN GAP: commands with dot-space in content (e.g. file.txt) are flagged as unsafe", () => {
    // ". " token catches ".script" extension as it matches dot-space in "file.txt "
    expect(ShellSafety.classifyBashRisk("cat file.txt")).toBe("shell")
    expect(ShellSafety.classifyBashRisk("cat script.sh")).toBe("shell")
  })
})

// ------------------------------------------------------------------
// 7. isReadOnly — backward-compatible export
// ------------------------------------------------------------------
describe("ShellSafety isReadOnly", () => {
  const { ShellSafety } = require("../../src/enforcement/shell-safety")

  test("read-only commands return true", () => {
    expect(ShellSafety.isReadOnly("ls")).toBe(true)
    expect(ShellSafety.isReadOnly("git log --oneline")).toBe(true)
    expect(ShellSafety.isReadOnly("git diff HEAD~1")).toBe(true)
    expect(ShellSafety.isReadOnly("git show")).toBe(true)
    expect(ShellSafety.isReadOnly("pwd")).toBe(true)
    expect(ShellSafety.isReadOnly("head -5 myfile")).toBe(true)
    expect(ShellSafety.isReadOnly("wc -l input.txt")).toBe(true)
  })

  test("non-read-only commands return false", () => {
    expect(ShellSafety.isReadOnly("rm file.txt")).toBe(false)
    expect(ShellSafety.isReadOnly("git push")).toBe(false)
    expect(ShellSafety.isReadOnly("export FOO=bar")).toBe(false)
    expect(ShellSafety.isReadOnly("curl example.com")).toBe(false)
    expect(ShellSafety.isReadOnly("python3 -c 'print(1)'")).toBe(false)
    expect(ShellSafety.isReadOnly("ssh user@host")).toBe(false)
  })

  test("safe redirects stripped before token check", () => {
    expect(ShellSafety.isReadOnly("ls -la 2>/dev/null")).toBe(true)
    expect(ShellSafety.isReadOnly("git log 2>&1")).toBe(true)
  })

  test("KNOWN GAP: cat file.txt is NOT read-only due to . token", () => {
    // The ". " token (intended to catch `source` via `. /tmp/evil.sh`)
    // also matches dot in "file.txt " after wrapping.
    expect(ShellSafety.isReadOnly("cat file.txt")).toBe(false)
  })
})

// ------------------------------------------------------------------
// 8. capability — backward-compatible export
// ------------------------------------------------------------------
describe("ShellSafety capability", () => {
  const { ShellSafety } = require("../../src/enforcement/shell-safety")

  test("read-only commands return shell_read capability", () => {
    expect(ShellSafety.capability("ls")).toBe("shell_read")
    expect(ShellSafety.capability("git log")).toBe("shell_read")
  })

  test("non-read-only commands return shell capability", () => {
    expect(ShellSafety.capability("rm -rf dir")).toBe("shell")
    expect(ShellSafety.capability("bun run build")).toBe("shell")
  })
})
