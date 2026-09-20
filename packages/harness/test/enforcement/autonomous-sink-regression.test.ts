import { describe, expect, test } from "bun:test"
const { EnforcementGate } = await import("../../src/enforcement/gate")

const WORKSPACE = "/Users/test/synergy-control-profile"

// ---------------------------------------------------------------------------
// Regression: autonomous bash around /dev/null-family sinks and compound
// commands. A shell command string is the imprecise input, so bash predicts no
// filesystem path at all: which file a command reaches is decided by the OS
// sandbox from the real syscall. These anchors pin that boundary — a null sink
// and every other spelling must never surface a file_* capability, while the
// boundaries the sandbox cannot express (raw device writes) stay refused.
// ---------------------------------------------------------------------------

const REPOSCAN_COMMAND = [
  "out=/tmp/des-reposcan.txt",
  ': > "$out"',
  "for d in */; do",
  '  d="${d%/}"',
  '  [ -d "$d/.git" ] || continue',
  "  {",
  '    echo "=== $d"',
  '    remotes=$(git -C "$d" remote 2>/dev/null)',
  '    if [ -n "$remotes" ]; then',
  "      for r in $remotes; do",
  '        echo "remote[$r]: $(git -C "$d" remote get-url "$r" 2>/dev/null)"',
  "      done",
  "    else",
  '      echo "remote: <none>"',
  "    fi",
  '    git -C "$d" status -sb 2>/dev/null | head -1',
  "    git -C \"$d\" log -1 --format='last: %cs | %s' 2>/dev/null",
  '    echo "dirty: $(git -C "$d" status --porcelain 2>/dev/null | wc -l | tr -d \' \')"',
  '  } >> "$out" 2>&1',
  "done",
  'wc -l "$out"',
].join("\n")

function fileCapabilities(envelope: any): string[] {
  return envelope.capabilities.map((cap: any) => cap.class as string).filter((name: string) => name.startsWith("file_"))
}

async function autonomousGate() {
  return EnforcementGate.create({
    activeWorkspace: WORKSPACE,
    workspaceType: "worktree",
    profileId: "autonomous",
  })
}

describe("autonomous bash sink regression (Phase 0)", () => {
  test("repo-scan script is allowed under autonomous with no file capability", async () => {
    const gate = await autonomousGate()

    const envelope = gate.evaluate("bash", {
      command: REPOSCAN_COMMAND,
      workdir: WORKSPACE,
    })

    expect(envelope.decision).toBe("allow")
    expect(fileCapabilities(envelope)).toEqual([])
  })

  // Sink spellings, dynamic targets, and absolute paths are all sandbox-owned.
  test.each([
    'for d in *; do ls "$d" 2>/dev/null; done',
    'for d in *; do ls "$d" 2>/dev/null); done',
    'x=$(git -C . log -1 2>/dev/null); echo "$x"',
    'out=/tmp/des-reposcan.txt; { git status -sb 2>/dev/null | head -1; } > /dev/null 2>&1; wc -l "$out"',
    "git status -sb 2>/dev/null | head -1",
    'for f in *.ts; do wc -l "$f" 2>/dev/null; done',
    'for d in */; do git -C "$d" log -1 --oneline 2>/dev/null; done',
  ])("null-sink compound emits no file capability: %j", async (command: string) => {
    const gate = await autonomousGate()
    const envelope = gate.evaluate("bash", { command, workdir: WORKSPACE })
    expect(envelope.decision).toBe("allow")
    expect(fileCapabilities(envelope)).toEqual([])
  })

  // A dynamic `cd` into an unresolvable target is no longer predicted as an
  // opaque external write: the sandbox contains the command wherever it lands.
  test("dynamic cd compound is sandbox-owned, not an opaque prediction", async () => {
    const gate = await autonomousGate()
    for (const command of [
      'for d in */; do (cd "$d" && git log -1 --oneline) 2>/dev/null; done',
      'for d in */; do (cd "$d" && echo x > out.txt); done',
    ]) {
      const envelope = gate.evaluate("bash", { command, workdir: WORKSPACE })
      expect({ command, decision: envelope.decision }).toEqual({ command, decision: "allow" })
      expect({ command, file: fileCapabilities(envelope) }).toEqual({ command, file: [] })
    }
  })

  // Absolute targets are the sandbox's business in every direction: the gate
  // stops predicting reads, writes, and directory changes for a command string.
  test.each([
    "cp a /etc/x",
    "mv a /etc/x",
    "cat < /etc/passwd",
    "git status > /tmp/out",
    "git status > out.txt",
    "cat /etc/passwd",
  ])("an absolute target is not predicted as a file capability: %j", async (command: string) => {
    const gate = await autonomousGate()
    const envelope = gate.evaluate("bash", { command, workdir: WORKSPACE })
    expect({ command, file: fileCapabilities(envelope) }).toEqual({ command, file: [] })
    expect({ command, decision: envelope.decision }).toEqual({ command, decision: "allow" })
  })

  test("a raw-device write stays refused (a boundary the sandbox cannot express)", async () => {
    const gate = await autonomousGate()
    const dd = gate.evaluate("bash", { command: "dd if=/dev/zero of=/dev/sda", workdir: WORKSPACE })
    expect(dd.decision).toBe("deny")
    expect(dd.capabilities.some((cap: any) => cap.class === "shell_hardline")).toBe(true)
  })

  test("external path separators in a compound stay path-free", async () => {
    const gate = await autonomousGate()
    const envelope = gate.evaluate("bash", {
      command: 'ls /Users/test/other-project/ && echo --- && ls /Users/test/projects/ | grep -i -E "meme|lingo"',
      workdir: WORKSPACE,
    })
    expect(envelope.decision).toBe("allow")
    expect(fileCapabilities(envelope)).toEqual([])
  })
})
