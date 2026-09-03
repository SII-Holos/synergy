import { describe, expect, test } from "bun:test"
const { EnforcementGate } = await import("../../src/enforcement/gate")

const WORKSPACE = "/Users/test/synergy-control-profile"

// ---------------------------------------------------------------------------
// Regression: autonomous bash false positives around /dev/null-family sinks
// and compound commands (Blueprinted fix). The reported repo-scan script was
// denied as file_external_write because `2>/dev/null)` inside a compound was
// extracted as the pseudo path "/dev/null)" and classified as a write target.
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

describe("autonomous bash sink regression (Phase 0)", () => {
  test("repo-scan script is allowed under autonomous with no file_external_write", async () => {
    const gate = await EnforcementGate.create({
      activeWorkspace: WORKSPACE,
      workspaceType: "worktree",
      profileId: "autonomous",
    })

    const envelope = gate.evaluate("bash", {
      command: REPOSCAN_COMMAND,
      workdir: WORKSPACE,
    })

    expect(envelope.decision).toBe("allow")
    expect(envelope.capabilities.some((c: any) => c.class === "file_external_write")).toBe(false)
    expect(envelope.capabilities.some((c: any) => c.class === "file_external_read")).toBe(false)
  })

  // Sink spellings that contain no dynamic directory change or real write
  // target must be allowed under autonomous.
  test.each([
    'for d in *; do ls "$d" 2>/dev/null; done',
    'for d in *; do ls "$d" 2>/dev/null); done',
    'x=$(git -C . log -1 2>/dev/null); echo "$x"',
    'out=/tmp/des-reposcan.txt; { git status -sb 2>/dev/null | head -1; } > /dev/null 2>&1; wc -l "$out"',
    "git status -sb 2>/dev/null | head -1",
    'for f in *.ts; do wc -l "$f" 2>/dev/null; done',
    'for d in */; do git -C "$d" log -1 --oneline 2>/dev/null; done',
  ])("null-sink compound is allowed with no external path: %j", async (command: string) => {
    const gate = await EnforcementGate.create({
      activeWorkspace: WORKSPACE,
      workspaceType: "worktree",
      profileId: "autonomous",
    })
    const envelope = gate.evaluate("bash", { command, workdir: WORKSPACE })
    expect(envelope.decision).toBe("allow")
    expect(envelope.capabilities.some((c: any) => c.class === "file_external_write")).toBe(false)
    expect(envelope.capabilities.some((c: any) => c.class === "file_external_read")).toBe(false)
  })

  // A dynamic `cd` into an un-resolvable target inside a compound stays a
  // conservative opaque external-write deny (variable cd could escape the
  // workspace). This is the intended boundary, not a false positive.
  test("dynamic cd compound stays conservative deny (opaque external write)", async () => {
    const gate = await EnforcementGate.create({
      activeWorkspace: WORKSPACE,
      workspaceType: "worktree",
      profileId: "autonomous",
    })
    for (const command of [
      'for d in */; do (cd "$d" && git log -1 --oneline) 2>/dev/null; done',
      'for d in */; do (cd "$d" && echo x > out.txt); done',
    ]) {
      const envelope = gate.evaluate("bash", { command, workdir: WORKSPACE })
      expect(envelope.decision).toBe("deny")
      const opaque = envelope.capabilities.find((c: any) => c.class === "file_external_write" && c.opaque)
      expect(opaque).toBeDefined()
    }
  })

  // Safety anchors: genuine external writes and protected paths stay denied.
  test("literal external write cp a /etc/x stays file_external_write", async () => {
    const gate = await EnforcementGate.create({
      activeWorkspace: WORKSPACE,
      workspaceType: "worktree",
      profileId: "autonomous",
    })
    const envelope = gate.evaluate("bash", { command: "cp a /etc/x", workdir: WORKSPACE })
    expect(envelope.decision).toBe("deny")
  })

  test("cat < /etc/passwd stays an external read (input redirection preserved)", async () => {
    const gate = await EnforcementGate.create({
      activeWorkspace: WORKSPACE,
      workspaceType: "worktree",
      profileId: "autonomous",
    })
    const result = gate.classify("bash", { command: "cat < /etc/passwd", workdir: WORKSPACE })
    const external = result.capabilities.find((c: any) => c.class === "file_external_read")!
    expect(external).toBeDefined()
    expect(external.nonBypassable).toBe(false)
    expect(external.paths).toContain("/etc/passwd")
  })

  test("mv across the boundary and dd raw device stays destructive/external", async () => {
    const gate = await EnforcementGate.create({
      activeWorkspace: WORKSPACE,
      workspaceType: "worktree",
      profileId: "autonomous",
    })
    expect(gate.evaluate("bash", { command: "mv a /etc/x", workdir: WORKSPACE }).decision).toBe("deny")
    const dd = gate.evaluate("bash", { command: "dd if=/dev/zero of=/dev/sda", workdir: WORKSPACE })
    expect(dd.decision).toBe("deny")
  })

  // Write-redirect targets on otherwise read-only commands are real writes:
  // an external target must surface file_external_write (never a read).
  test("write redirect to an external literal path is an external write", async () => {
    const gate = await EnforcementGate.create({
      activeWorkspace: WORKSPACE,
      workspaceType: "worktree",
      profileId: "autonomous",
    })
    const result = gate.classify("bash", { command: "git status > /tmp/out", workdir: WORKSPACE })
    const externalWrite = result.capabilities.find((c: any) => c.class === "file_external_write")
    expect(externalWrite).toBeDefined()
    expect(externalWrite?.paths).toContain("/tmp/out")
    // The redirect target is a write, never a read capability.
    expect(
      result.capabilities.some((c: any) => c.class === "file_external_read" && c.paths?.includes("/tmp/out")),
    ).toBe(false)
    expect(gate.evaluate("bash", { command: "git status > /tmp/out", workdir: WORKSPACE }).decision).toBe("deny")
  })

  test("write redirect to a workspace path is a workspace write", async () => {
    const gate = await EnforcementGate.create({
      activeWorkspace: WORKSPACE,
      workspaceType: "worktree",
      profileId: "autonomous",
    })
    const result = gate.classify("bash", { command: "git status > out.txt", workdir: WORKSPACE })
    expect(result.capabilities.some((c: any) => c.class === "file_external_write")).toBe(false)
    expect(result.capabilities.some((c: any) => c.class === "file_write")).toBe(true)
  })
})
