import { describe, expect, test } from "bun:test"
const { EnforcementGate } = await import("../../src/enforcement/gate")
const { ShellSafety } = await import("../../src/enforcement/shell-safety")

// ---------------------------------------------------------------------------
// Regression: autonomous-profile false denials of benign read-only bash
// commands that use find/fd -exec with read-only utilities, assignment +
// $(...) substitutions, slash-relative cd, and awk regex literals.
//
// Four root causes (all reproduced live against dev HEAD before this file):
//   F1 shell-safety.ts ARGUMENT_INJECTION_PATTERNS blanket find/fd rules
//      treat `-exec cat/wc {} +` as destructive without inspecting the tool.
//   F2 shellWords has no $(...)/backtick depth, so `files=$(find "$d" ...)`
//      mis-splits and the `"$d)"` fragment is read as a dynamic command name,
//      producing a "sudo" tag and opaque directory-change risk.
//   F3 cdpathDependentDirectoryTarget marks slash-relative cd (e.g.
//      `cd packages/synergy/src`) opaque although the execution environment
//      allowlist never carries CDPATH.
//   F4 gate extractAbsolutePaths surfaces awk regex literals such as
//      /^\.\//) as external write path candidates.
// ---------------------------------------------------------------------------

const WORKSPACE = "/Users/test/synergy-control-profile"

const CORPUS: Array<{ id: string; command: string; workdir?: string }> = [
  {
    id: "cmd1",
    command:
      "cd packages/synergy/src && for d in */; do d=${d%/}; [ -d \"$d\" ] || continue; files=$(find \"$d\" -type f \\( -name '*.ts' -o -name '*.txt' \\) | wc -l | tr -d ' '); loc=$(find \"$d\" -type f -name '*.ts' -exec cat {} + 2>/dev/null | wc -l | tr -d ' '); echo \"$d $files $loc\"; done | sort -k3 -nr",
  },
  {
    id: "cmd2",
    command:
      "cd packages/synergy/src && echo \"--- dir file counts (top level only) ---\" && find . -maxdepth 1 -type d | sort && echo \"--- total ts files & loc ---\" && find . -type f -name '*.ts' | wc -l && find . -type f -name '*.ts' -exec cat {} + | wc -l",
  },
  {
    id: "cmd3",
    command:
      'for d in */; do d="${d%/}"; [ -d "$d" ] || continue; files=$(find "$d" -type f \\( -name \'*.ts\' -o -name \'*.txt\' \\) | wc -l | tr -d \' \'); loc=$(find "$d" -type f -name \'*.ts\' -exec cat {} + 2>/dev/null | wc -l | tr -d \' \'); printf \'%s %s %s\\n\' "$d" "$files" "$loc"; done | sort -k3 -nr',
    workdir: `${WORKSPACE}/packages/synergy/src`,
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

describe("autonomous bash exec precision — R2 destructive exec stays blocked", () => {
  test.each([
    "find . -exec rm {} +",
    "find . -exec rm {} \\;",
    "find . -exec sh -c 'echo hi' {} \\;",
    "find . -exec curl http://example.com -o /tmp/f {} \\;",
    "find . -delete",
    "find . -ok rm {} \\;",
    "find . -okdir rm {} \\;",
    "fd pattern -x rm",
    "fd pattern --exec rm {}",
    "fd pattern --exec-batch rm",
    "find . -exec phantom-cmd {} +",
    "find /tmp -exec rm {} \\;",
    "find . -exec rm {} + -o -exec cat {} +",
    // Wrapped destructive exec: quote-masked payload text must be rescanned
    // after unwrapping shell re-parse payloads, or non-rm mutators and
    // unknown utilities slip through the per-utility whitelist.
    "sh -c 'find . -exec gzip {} +'",
    'bash -c "find . -exec gzip {} +"',
    "sh -c 'find . -exec rm {} +'",
    "eval 'find . -exec gzip {} +'",
    "eval 'find . -ok rm {} +'",
    "eval 'find . -okdir cat {} +'",
    "trap 'find . -exec gzip {} +' EXIT",
    "xargs sh -c 'find . -exec chmod 777 {} +'",
    "sh -c 'find . -exec phantom-cmd {} +'",
    "sh -c 'find . -delete'",
    "nohup sh -c 'find . -exec gzip {} +' &",
    "f() { find . -exec gzip {} +; }; f",
    "busybox find . -exec rm {} +",
  ])("destructive find/fd form stays shell_destructive: %s", (command) => {
    expect(ShellSafety.classifyBashRisk(command)).toBe("shell_destructive")
  })

  test("read-only find/fd exec tools are no longer blanket destructive", () => {
    for (const command of [
      "find . -exec cat {} +",
      "find . -type f -name '*.ts' -exec wc -l {} +",
      "find . -exec ls {} \\;",
      "find . -execdir cat {}",
      "find . -exec echo {} \\;",
      "find . -exec cat {} \\;",
      "fd pattern --exec echo {}",
    ]) {
      expect(ShellSafety.classifyBashRisk(command)).not.toBe("shell_destructive")
    }
  })

  test("read-only find/fd exec wrapped in shell payloads stays allowed", () => {
    for (const command of [
      "sh -c 'find . -exec cat {} +'",
      "bash -c 'find . -type f -name x -exec wc -l {} +'",
      "eval 'find . -exec cat {} +'",
      "xargs sh -c 'find . -exec cat {} +'",
    ]) {
      expect(ShellSafety.classifyBashRisk(command)).not.toBe("shell_destructive")
    }
  })
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

  test("directory analysis is not opaque when only an assignment+substitution supplies the dollar word", () => {
    const analysis = ShellSafety.analyzeDirectoryChanges(
      'for d in */; do x=$(find "$d" \\( -name x \\) | wc -l); echo done; done',
    )
    expect(analysis.opaque).toBe(false)
  })

  test("whole corpus commands carry no sudo label", () => {
    for (const { command } of CORPUS) {
      expect(ShellSafety.hasSudoInvocation(command)).toBe(false)
    }
  })
})

describe("autonomous bash exec precision — R5 slash-relative cd resolution", () => {
  test("slash-relative cd resolves statically under resolveSlashRelativeCd", () => {
    const analysis = ShellSafety.analyzeDirectoryChanges("cd packages/synergy/src && ls", {
      resolveSlashRelativeCd: true,
    })
    expect(analysis).toEqual({ targets: ["packages/synergy/src"], opaque: false })
  })

  test("bare-name cd stays opaque (CDPATH ambiguity)", () => {
    const analysis = ShellSafety.analyzeDirectoryChanges("cd node_modules && touch changed.txt", {
      resolveSlashRelativeCd: true,
    })
    expect(analysis.opaque).toBe(true)
  })

  test("dynamic slash-relative cd targets stay opaque under resolveSlashRelativeCd", () => {
    for (const command of [
      "cd $DIR/x && touch changed.txt",
      "cd $HOME/sub && touch changed.txt",
      'cd "$d/src" && touch changed.txt',
      "cd packages/$x && touch changed.txt",
      "pushd $D/x && touch changed.txt",
      "cd `echo a/b` && touch changed.txt",
    ]) {
      const analysis = ShellSafety.analyzeDirectoryChanges(command, { resolveSlashRelativeCd: true })
      expect(analysis.opaque).toBe(true)
      expect(analysis.targets).toEqual([])
    }
  })

  test("commands defining CDPATH stay opaque even for slash-relative targets", () => {
    for (const command of [
      "CDPATH=/Users/test/synergy cd packages/x && touch changed.txt",
      "export CDPATH=/x; cd packages/y && touch changed.txt",
    ]) {
      const analysis = ShellSafety.analyzeDirectoryChanges(command, { resolveSlashRelativeCd: true })
      expect(analysis.opaque).toBe(true)
    }
  })

  test("default (no options) keeps current conservative behavior for slash-relative cd", () => {
    // Backward-compatible default: without the option nothing changes.
    expect(ShellSafety.analyzeDirectoryChanges("cd packages/x && ls").opaque).toBe(true)
  })

  test("gate wires resolveSlashRelativeCd so workspace-relative cd plus touch stays inside", async () => {
    const gate = await EnforcementGate.create({
      activeWorkspace: WORKSPACE,
      workspaceType: "worktree",
      profileId: "autonomous",
    })
    const envelope = gate.evaluate("bash", {
      command: "cd packages/synergy/src && touch changed.txt",
      workdir: WORKSPACE,
    })
    expect(envelope.capabilities.some((c: any) => c.class === "file_external_write")).toBe(false)
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

  test("real absolute and protected paths still classify as before", async () => {
    const gate = await EnforcementGate.create({
      activeWorkspace: WORKSPACE,
      workspaceType: "worktree",
      profileId: "autonomous",
    })
    const read = gate.classify("bash", { command: "cat /etc/passwd", workdir: WORKSPACE })
    expect(read.capabilities.some((c: any) => c.class === "file_external_read")).toBe(true)
    const protectedPath = gate.classify("bash", { command: "cat /.env", workdir: WORKSPACE })
    expect(protectedPath.capabilities.some((c: any) => c.class === "protected_op" || c.class === "secrets")).toBe(true)
  })
})
