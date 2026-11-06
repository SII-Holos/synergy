import { describe, expect, test } from "bun:test"
const { EnforcementGate } = await import("../../src/enforcement/gate")
const { ShellSafety } = await import("../../src/enforcement/shell-safety")

// ---------------------------------------------------------------------------
// Regression: autonomous-profile bash commands that must stay allowed.
//
// Historically these were false denials produced by gate-side path
// prediction (find/fd exec-target inspection, directory-change analysis,
// absolute-path extraction). That machine is gone: a shell command string is
// the imprecise input, so its filesystem reach belongs to the OS sandbox and
// bash contributes only the capabilities the sandbox cannot express.
//
// What remains asserted here is (a) the released corpus stays allowed with no
// destructive or external-write tag, and (b) the surviving anchors
// (injection patterns, escalation, substitution handling) still hold.
// ---------------------------------------------------------------------------

const WORKSPACE = "/Users/test/synergy-control-profile"

const CORPUS: Array<{ id: string; command: string; workdir?: string }> = [
  {
    id: "cmd1",
    command:
      "cd packages/harness/src && for d in */; do d=${d%/}; [ -d \"$d\" ] || continue; files=$(find \"$d\" -type f \\( -name '*.ts' -o -name '*.txt' \\) | wc -l | tr -d ' '); loc=$(find \"$d\" -type f -name '*.ts' -exec cat {} + 2>/dev/null | wc -l | tr -d ' '); echo \"$d $files $loc\"; done | sort -k3 -nr",
  },
  {
    id: "cmd2",
    command:
      "cd packages/harness/src && echo \"--- dir file counts (top level only) ---\" && find . -maxdepth 1 -type d | sort && echo \"--- total ts files & loc ---\" && find . -type f -name '*.ts' | wc -l && find . -type f -name '*.ts' -exec cat {} + | wc -l",
  },
  {
    id: "cmd3",
    command:
      'for d in */; do d="${d%/}"; [ -d "$d" ] || continue; files=$(find "$d" -type f \\( -name \'*.ts\' -o -name \'*.txt\' \\) | wc -l | tr -d \' \'); loc=$(find "$d" -type f -name \'*.ts\' -exec cat {} + 2>/dev/null | wc -l | tr -d \' \'); printf \'%s %s %s\\n\' "$d" "$files" "$loc"; done | sort -k3 -nr',
    workdir: `${WORKSPACE}/packages/harness/src`,
  },
  {
    id: "cmd4",
    command:
      "find . -type f -name '*.ts' -exec wc -l {} + | awk -F'/' '{if ($0 ~ / total$/) next; d=$2; n=$(NF-0)}' 2>/dev/null; echo \"---try2---\"; find . -type f -name '*.ts' -exec wc -l {} + | awk '{if (NF>=2 && $2 ~ /^\\.\\//) {split($2,a,\"/\"); dir=a[2]; lines[dir]+=$1; files[dir]++} else if ($2 ~ /^\\.\\.\\/$/){} } END {for (d in lines) print d, files[d], lines[d]}' | sort -k3 -nr",
  },
]

describe("autonomous bash exec precision — R1 corpus allow", () => {
  test.each(CORPUS.map((item) => [item.id, item.command, item.workdir]))(
    "corpus %s evaluates to allow with no destructive/external-write/sudo tag",
    async (id: string, command: string, workdir?: string) => {
      const gate = await EnforcementGate.create({
        activeWorkspace: WORKSPACE,
        workspaceType: "worktree",
        profileId: "autonomous",
      })
      const envelope = gate.evaluate("bash", { command, ...(workdir ? { workdir } : {}) })

      expect(envelope.decision).toBe("allow")
      const classes = envelope.capabilities.map((c: any) => c.class)
      expect(classes).not.toContain("shell_destructive")
      expect(classes).not.toContain("shell_hardline")
      expect(classes).not.toContain("file_external_write")
      // No "matched destructive pattern: sudo" style mislabel on any capability.
      for (const cap of envelope.capabilities) {
        if (cap.reason) expect(cap.reason).not.toMatch(/sudo/)
      }
      // No opaque external-write fallback (dynamic/unresolvable cd) for the corpus.
      const external = envelope.capabilities.find((c: any) => c.class === "file_external_write")
      expect(external).toBeUndefined()
    },
  )
})

describe("autonomous bash exec precision — R3 other injection anchors unchanged", () => {
  test.each([
    "rg pattern --pre bash",
    "ripgrep foo --pre-glob '*.sh' --pre bash",
    "go test -exec 'bash -c \"echo pwned\"'",
    "git show --output=payload",
    "git config --global user.name evil",
    "bash -c 'git push'",
    "python3 -c \"import subprocess; subprocess.run(['git','push'])\"",
  ])("non-find injection stays shell_destructive: %s", (command) => {
    expect(ShellSafety.classifyBashRisk(command)).toBe("shell_destructive")
  })
})

describe("autonomous bash exec precision — R4 assignment + substitution", () => {
  test("assignment with $(...) and a quoted variable no longer reads as dynamic command name", () => {
    expect(ShellSafety.hasSudoInvocation('x=$(ls "$d" | wc -l)')).toBe(false)
    expect(ShellSafety.hasSudoInvocation("files=$(find \"$d\" -type f \\( -name '*.ts' \\) | wc -l | tr -d ' ')")).toBe(
      false,
    )
    expect(
      ShellSafety.hasSudoInvocation(
        "loc=$(find \"$d\" -type f -name '*.ts' -exec cat {} + 2>/dev/null | wc -l | tr -d ' ')",
      ),
    ).toBe(false)
  })

  test("whole corpus commands carry no sudo label", () => {
    for (const { command } of CORPUS) {
      expect(ShellSafety.hasSudoInvocation(command)).toBe(false)
    }
  })
})

describe("autonomous bash exec precision — R6 awk regex literals are not paths", () => {
  test("corpus cmd4 carries no external path candidates", async () => {
    const gate = await EnforcementGate.create({
      activeWorkspace: WORKSPACE,
      workspaceType: "worktree",
      profileId: "autonomous",
    })
    const envelope = gate.evaluate("bash", { command: CORPUS[3]!.command, workdir: WORKSPACE })
    expect(envelope.decision).toBe("allow")
    const external = envelope.capabilities.find((c: any) => c.class === "file_external_write")
    expect(external).toBeUndefined()
    const readExternal = envelope.capabilities.find((c: any) => c.class === "file_external_read")
    expect(readExternal).toBeUndefined()
  })

  test("awk -F / field separator and regex fragments produce no external path", async () => {
    const gate = await EnforcementGate.create({
      activeWorkspace: WORKSPACE,
      workspaceType: "worktree",
      profileId: "autonomous",
    })
    for (const command of [
      "find . -type f -exec wc -l {} + | awk -F'/' '{print $1}'",
      "find . -type f -exec cat {} + | awk '$0 ~ /^abc/ {print}'",
    ]) {
      const result = gate.classify("bash", { command, workdir: WORKSPACE })
      const externalWrite = result.capabilities.find((c: any) => c.class === "file_external_write")
      if (externalWrite) {
        expect(externalWrite.paths ?? []).toHaveLength(0)
      }
      const externalRead = result.capabilities.find((c: any) => c.class === "file_external_read")
      if (externalRead) {
        expect(externalRead.paths ?? []).toHaveLength(0)
      }
    }
  })

  test("bash predicts no path at all, including for real external and protected paths", async () => {
    // A shell command string is the imprecise input: which file it reaches is
    // decided by the OS sandbox, never predicted here. Structured tools keep
    // owning their literal path arguments (see ownership-inversion.test.ts).
    const gate = await EnforcementGate.create({
      activeWorkspace: WORKSPACE,
      workspaceType: "worktree",
      profileId: "autonomous",
    })
    for (const command of ["cat /etc/passwd", "cat /.env", "cat ~/.ssh/id_rsa"]) {
      const result = gate.classify("bash", { command, workdir: WORKSPACE })
      expect({
        command,
        file: result.capabilities
          .map((c: any) => c.class)
          .filter((name: string) => name.startsWith("file_") || name === "secrets" || name === "protected_op"),
      }).toEqual({ command, file: [] })
    }
  })
})
