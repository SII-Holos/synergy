import { describe, expect, test } from "bun:test"
import { SYNERGY_CAPABILITY_DETAILS, SYNERGY_PROFILE_CAPABILITIES } from "@ericsanchezok/synergy-util/capability"
const { EnforcementGate } = await import("../../src/enforcement/gate")
const { ShellSafety } = await import("../../src/enforcement/shell-safety")

// ---------------------------------------------------------------------------
// enforcement/ownership-inversion.test.ts
//
// One execution-time owner per capability class. Precise-input capabilities
// (literal path arguments of structured tools) belong to the policy layer; the
// imprecise-input capability (a shell command string) belongs to the execution
// layer (the OS sandbox). Neither layer predicts the other's answer.
//
// bash is the only imprecise input in this repository, so bash contributes only
// the capabilities the sandbox cannot express, and every filesystem decision
// inside a shell command is settled by the sandbox rather than by gate-side
// path prediction.
//
// Reject side: the sandbox-inexpressible shapes must stay refused.
// Release side: filesystem-only shapes must stop being predicted.
// ---------------------------------------------------------------------------

const WORKSPACE = "/Users/test/synergy-control-profile"

const FILE_CLASSES = ["file_read", "file_write", "file_external_read", "file_external_write"]

async function gateFor(profileId: "guarded" | "autonomous" | "full_access") {
  return EnforcementGate.create({
    activeWorkspace: WORKSPACE,
    workspaceType: "worktree",
    originalCheckout: "/Users/test/synergy",
    profileId,
  })
}

function fileCapabilities(envelope: any): any[] {
  return envelope.capabilities.filter((cap: any) => FILE_CLASSES.includes(cap.class))
}

// ---------------------------------------------------------------------------
// 1. The eleven shapes must still be refused with no path-prediction machine.
// ---------------------------------------------------------------------------
const HOST_LEVEL_SHAPES = [
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

describe("ownership inversion — sandbox-inexpressible shapes stay refused", () => {
  test.each(HOST_LEVEL_SHAPES)("autonomous refuses %j", async (command) => {
    const gate = await gateFor("autonomous")
    expect(gate.evaluate("bash", { command, workdir: WORKSPACE }).decision).toBe("deny")
  })

  test.each(HOST_LEVEL_SHAPES)("guarded never silently allows %j", async (command) => {
    const gate = await gateFor("guarded")
    expect(gate.evaluate("bash", { command, workdir: WORKSPACE }).decision).not.toBe("allow")
  })

  test.each(HOST_LEVEL_SHAPES)("the surviving classifier still refuses %j", (command) => {
    const risk = ShellSafety.classifyBashRisk(command)
    const refused = risk === "shell_destructive" || risk === "shell_hardline" || ShellSafety.isHardline(command)
    expect({ command, refused }).toEqual({ command, refused: true })
  })
})

// ---------------------------------------------------------------------------
// 2. bash emits no file capability at all: filesystem reach in a shell command
//    is decided by the sandbox, never predicted by the gate.
// ---------------------------------------------------------------------------
const PATH_BEARING_COMMANDS = [
  "cat /etc/passwd",
  "cat ~/.ssh/id_rsa",
  "cp a /etc/x",
  "mv a /etc/x",
  "git status > /tmp/out",
  "git status > out.txt",
  "rm -rf /tmp/scratch",
  "cd /etc && ls",
  "ls /Users/test/other-project/",
  'for d in */; do (cd "$d" && echo x > out.txt); done',
  'out=/tmp/x; : > "$out"',
]

describe("ownership inversion — bash contributes no file capability", () => {
  test.each(PATH_BEARING_COMMANDS)("autonomous bash emits no file_* for %j", async (command) => {
    const gate = await gateFor("autonomous")
    const envelope = gate.evaluate("bash", { command, workdir: WORKSPACE })
    expect(fileCapabilities(envelope)).toEqual([])
  })

  test.each(PATH_BEARING_COMMANDS)("guarded bash emits no file_* for %j", async (command) => {
    const gate = await gateFor("guarded")
    const envelope = gate.evaluate("bash", { command, workdir: WORKSPACE })
    expect(fileCapabilities(envelope)).toEqual([])
  })

  test("the bash workdir argument is not predicted either", async () => {
    const gate = await gateFor("autonomous")
    const envelope = gate.evaluate("bash", { command: "ls -la", workdir: "/etc" })
    expect(fileCapabilities(envelope)).toEqual([])
  })

  test("structured tools keep owning their literal path arguments", async () => {
    const gate = await gateFor("autonomous")
    const external = gate.classify("read", { filePath: "/etc/passwd" })
    expect(external.capabilities.some((cap: any) => cap.class === "file_external_read")).toBe(true)
    const inside = gate.classify("write", { filePath: `${WORKSPACE}/out.txt` })
    expect(inside.capabilities.some((cap: any) => cap.class === "file_write")).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 3. The five historical false-positive decision records: each recorded command
//    must be allowed under autonomous with no file capability emitted.
//
//    docs/decisions/implemented/bug-fix/2026-08-20-copy-operand-role-classification.md
//    docs/decisions/implemented/bug-fix/2026-09-03-null-device-sink-write-redirect-classification.md
//    docs/decisions/implemented/bug-fix/2026-09-04-autonomous-bash-sandbox-containment.md
//    docs/decisions/implemented/bug-fix/2026-09-05-autonomous-bash-exec-precision.md
//    docs/decisions/implemented/bug-fix/2026-09-10-unified-read-only-shell-catalog.md
// ---------------------------------------------------------------------------
const RELEASED_FALSE_POSITIVES: Array<{ record: string; command: string }> = [
  {
    record: "2026-08-20-copy-operand-role-classification",
    command: "cp ~/.cache/models.json ./cache/",
  },
  {
    record: "2026-09-03-null-device-sink-write-redirect-classification",
    command:
      'out=/tmp/des-reposcan.txt; : > "$out"; for d in */; do [ -d "$d/.git" ] || continue; git -C "$d" status -sb 2>/dev/null | head -1; done >> "$out" 2>&1; wc -l "$out"',
  },
  {
    record: "2026-09-04-autonomous-bash-sandbox-containment",
    command: 'for d in */; do d="${d%/}"; git -C "$d" log -1 --format="last: %cs" 2>/dev/null; done',
  },
  {
    record: "2026-09-05-autonomous-bash-exec-precision",
    command: "cd packages/harness/src && files=$(find . -type f -name '*.ts' -exec cat {} + 2>/dev/null | wc -l); echo $files",
  },
  {
    record: "2026-09-10-unified-read-only-shell-catalog",
    command: 'ls /Users/test/other-project/ && echo --- && ls /Users/test/projects/ | grep -i -E "meme|lingo"',
  },
]

describe("ownership inversion — historical false positives stay released", () => {
  test.each(RELEASED_FALSE_POSITIVES.map((item) => [item.record, item.command]))(
    "autonomous allows %s with no file capability",
    async (_record: string, command: string) => {
      const gate = await gateFor("autonomous")
      const envelope = gate.evaluate("bash", { command, workdir: WORKSPACE })
      expect(envelope.decision).toBe("allow")
      expect(fileCapabilities(envelope)).toEqual([])
      expect(envelope.capabilities.some((cap: any) => cap.class === "shell_destructive")).toBe(false)
      expect(envelope.capabilities.some((cap: any) => cap.class === "shell_hardline")).toBe(false)
    },
  )
})

// ---------------------------------------------------------------------------
// 4. find/fd command execution and in-workspace subtree removal are handed to
//    the sandbox: allowed inside the workspace, refused by the OS outside it.
// ---------------------------------------------------------------------------
const SANDBOX_OWNED_SHAPES = [
  "find . -delete",
  "find . -exec rm {} +",
  "find . -exec rm {} \\;",
  "find . -exec gzip {} +",
  "find . -ok rm {} \\;",
  "fd pattern -x rm",
  "rm -rf node_modules",
  "rm -r ./build",
  "rm -f ./tmp.log",
]

describe("ownership inversion — filesystem-only shapes move to the sandbox", () => {
  test.each(SANDBOX_OWNED_SHAPES)("autonomous no longer refuses %j", async (command) => {
    const gate = await gateFor("autonomous")
    const envelope = gate.evaluate("bash", { command, workdir: WORKSPACE })
    expect(envelope.decision).toBe("allow")
    expect(envelope.capabilities.some((cap: any) => cap.class === "shell_destructive")).toBe(false)
  })

  test.each(SANDBOX_OWNED_SHAPES)("the classifier no longer marks %j destructive", (command) => {
    const risk = ShellSafety.classifyBashRisk(command)
    expect({ command, risk }).toEqual({ command, risk: risk === "shell" ? "shell" : risk })
    expect(risk).toBe("shell")
  })

  // The external-target half of the accepted handover: the gate stops emitting
  // an external-write capability, and the OS sandbox is what refuses the write
  // outside the workspace (packages/runtime-local/test/sandbox/
  // containment-baseline.test.ts asserts the runtime EPERM side).
  test("an external target in the same shape carries no predicted capability", async () => {
    const gate = await gateFor("autonomous")
    for (const command of ["rm -rf /etc/foo", "find /etc -delete", "rm -rf ../outside"]) {
      const envelope = gate.evaluate("bash", { command, workdir: WORKSPACE })
      expect(fileCapabilities(envelope)).toEqual([])
    }
  })
})

// ---------------------------------------------------------------------------
// 5. full_access behavior is unchanged: every classified capability is still
//    silently authorized.
// ---------------------------------------------------------------------------
describe("ownership inversion — full_access parity", () => {
  const FULL_ACCESS_ALLOWED = [
    "ls -la",
    "git status",
    "rm -rf /",
    "shutdown -h now",
    "sudo rm -rf x",
    "find . -delete",
    "cat /etc/passwd",
    "cp a /etc/x",
    "git status > /tmp/out",
  ]

  test.each(FULL_ACCESS_ALLOWED)("full_access allows %j", async (command) => {
    const gate = await gateFor("full_access")
    const envelope = gate.evaluate("bash", { command, workdir: WORKSPACE })
    expect(envelope.decision).toBe("allow")
    expect(envelope.refusal).toBeUndefined()
  })

  test("full_access sandbox policy is untouched", async () => {
    const gate = await gateFor("full_access")
    expect(gate.getSandbox()).toMatchObject({ mode: "none", fallback: "allow" })
  })
})

// ---------------------------------------------------------------------------
// 6. The shell_read capability is retired from the table and the classifier.
// ---------------------------------------------------------------------------
describe("ownership inversion — shell_read is retired", () => {
  test("the capability table no longer declares shell_read", () => {
    expect(Object.keys(SYNERGY_CAPABILITY_DETAILS)).not.toContain("shell_read")
    expect(SYNERGY_PROFILE_CAPABILITIES as readonly string[]).not.toContain("shell_read")
  })

  test("no profile resolves a shell_read rule", async () => {
    for (const profileId of ["guarded", "autonomous", "full_access"] as const) {
      const gate = await gateFor(profileId)
      const permissions = gate.getProfileInfo().ruleset.map((item: any) => item.permission)
      expect(permissions).not.toContain("shell_read")
    }
  })

  test.each(["ls -la", "pwd", "git log --oneline", "ls | grep foo", "ls && git log"])(
    "the classifier no longer mints shell_read for %j",
    (command) => {
      expect(ShellSafety.classifyBashRisk(command)).toBe("shell")
    },
  )

  test("no bash evaluation mints a shell_read capability", async () => {
    const gate = await gateFor("autonomous")
    for (const command of ["ls -la", "cat file.txt", "git status", "echo hi"]) {
      const envelope = gate.evaluate("bash", { command, workdir: WORKSPACE })
      expect(envelope.capabilities.map((cap: any) => cap.class)).not.toContain("shell_read")
    }
  })
})

// ---------------------------------------------------------------------------
// 7. The privilege-escalation chain stays reachable from the surviving
//    classifier (MUST-PRESERVE list).
// ---------------------------------------------------------------------------
describe("ownership inversion — privilege escalation stays owned by the classifier", () => {
  const SUDO_SHAPES = [
    "sudo rm -rf x",
    "sh -c 'sudo rm -rf x'",
    "env sudo rm -rf x",
    "bash <<EOF\nsudo rm -rf x\nEOF",
    "eval 'sudo rm -rf x'",
    "trap 'sudo rm -rf x' EXIT",
    "f() { sudo rm -rf x; }; f",
    "xargs sudo rm -rf",
  ]

  test.each(SUDO_SHAPES)("the classifier still detects privilege escalation in %j", (command) => {
    expect(ShellSafety.hasSudoInvocation(command)).toBe(true)
    expect(ShellSafety.classifyBashRisk(command)).toBe("shell_destructive")
  })

  test("a quoted mention of sudo is still not privilege escalation", () => {
    expect(ShellSafety.hasSudoInvocation("echo sudo make install")).toBe(false)
    expect(ShellSafety.hasSudoInvocation(`python3 -c 'print("sudo")'`)).toBe(false)
  })

  test("irreversible destruction of a system location stays destructive", () => {
    expect(ShellSafety.classifyBashRisk("shred /etc/passwd")).toBe("shell_destructive")
    expect(ShellSafety.classifyBashRisk("truncate -s 0 /etc/hosts")).toBe("shell_destructive")
  })

  test("remote and branch risk classes survive", () => {
    expect(ShellSafety.classifyBashRisk("git push")).toBe("shell_remote_publish")
    expect(ShellSafety.classifyBashRisk("git push --force origin main")).toBe("shell_remote_write")
    expect(ShellSafety.classifyBashRisk("git checkout main")).toBe("shell_branch_mutation")
  })
})
