import { describe, expect, test } from "bun:test"
const { EnforcementGate } = await import("../../src/enforcement/gate")

const WORKSPACE = "/Users/test/synergy-control-profile"

async function evaluate(command: string) {
  const gate = await EnforcementGate.create({
    activeWorkspace: WORKSPACE,
    workspaceType: "worktree",
    profileId: "autonomous",
  })
  return gate.evaluate("bash", { command, workdir: WORKSPACE })
}

function pathsFor(envelope: any, ...classes: string[]) {
  return envelope.capabilities.filter((c: any) => classes.includes(c.class)).flatMap((c: any) => c.paths ?? [])
}

describe("write-redirect target classification (PR #1308 follow-up)", () => {
  // Every shell spelling that opens a file for writing must classify the
  // target as an external write under autonomous — including the clobber
  // form `>|`, the fd-prefixed clobber `2>|`, and the combined `>&word`
  // (which writes the file, unlike fd duplication `>&1`).
  test.each([
    "git status > /tmp/out",
    "git status >> /tmp/out",
    "git status >| /tmp/out",
    "git status 2>| /tmp/out",
    "git status >& /tmp/out",
    "git status &> /tmp/out",
    "git status &>> /tmp/out",
  ])("write-redirect spelling is an external write: %j", async (command: string) => {
    const envelope = await evaluate(command)
    expect(envelope.decision).toBe("deny")
    expect(pathsFor(envelope, "file_external_write")).toContain("/tmp/out")
  })

  // A quoted `>` is string content (search patterns), not a redirect.
  test.each(["git log --oneline --grep='a > /tmp/y'", "rg '> /tmp/y' -n src", 'grep "> /tmp/y" file.txt'])(
    "quoted '>' is string content, not a write: %j",
    async (command: string) => {
      const envelope = await evaluate(command)
      expect(envelope.decision).toBe("allow")
      expect(envelope.capabilities.some((c: any) => c.class === "file_external_write")).toBe(false)
    },
  )

  test("arithmetic comparison '>' is not a redirect", async () => {
    const envelope = await evaluate("(( i > 5 ))")
    expect(envelope.decision).toBe("allow")
    expect(pathsFor(envelope, "file_write", "file_external_write")).not.toContain(`${WORKSPACE}/5`)
  })

  test("[[ ]] comparison '>' is not a redirect", async () => {
    const envelope = await evaluate("[[ $a > /tmp/z ]]")
    expect(envelope.decision).toBe("allow")
    expect(envelope.capabilities.some((c: any) => c.class === "file_external_write")).toBe(false)
  })

  test("heredoc body '>' is literal data, not a write target", async () => {
    const envelope = await evaluate("cat <<'EOF'\nline > /tmp/heredoc-body\nEOF")
    expect(envelope.decision).toBe("allow")
    expect(envelope.capabilities.some((c: any) => c.class === "file_external_write")).toBe(false)
  })

  test("fd duplication and fd close are not file writes", async () => {
    const envelope = await evaluate("git status 2>&1 1>&2 3>&-")
    expect(envelope.decision).toBe("allow")
    expect(envelope.capabilities.some((c: any) => c.class === "file_external_write")).toBe(false)
  })

  test("null-device sinks stay non-paths in every spelling", async () => {
    for (const command of [
      "git status 2>/dev/null",
      "git status &>/dev/null",
      'x=$(git -C . log -1 2>/dev/null); echo "$x"',
    ]) {
      const envelope = await evaluate(command)
      expect(envelope.decision).toBe("allow")
      expect(envelope.capabilities.some((c: any) => c.class === "file_external_write")).toBe(false)
      expect(envelope.capabilities.some((c: any) => c.class === "file_external_read")).toBe(false)
    }
  })

  test("variable redirect target stays dynamic (sandbox boundary, not static)", async () => {
    const envelope = await evaluate('out=/tmp/f; : > "$out"')
    expect(envelope.decision).toBe("allow")
    expect(envelope.capabilities.some((c: any) => c.class === "file_external_write")).toBe(false)
  })

  test("redirect inside command substitution stays a write (conservative)", async () => {
    const envelope = await evaluate("echo $(date > /tmp/x)")
    expect(envelope.decision).toBe("deny")
    expect(pathsFor(envelope, "file_external_write")).toContain("/tmp/x")
  })

  test("workspace-relative redirect target is a workspace write", async () => {
    const envelope = await evaluate("git status > out.txt")
    expect(envelope.decision).toBe("allow")
    expect(pathsFor(envelope, "file_write")).toContain(`${WORKSPACE}/out.txt`)
  })
})

describe("network capability and sandbox network parity (PR #1308 follow-up)", () => {
  test.each([
    "git fetch",
    "git pull",
    "git push",
    "git clone https://example.com/r.git",
    "git ls-remote origin",
    "npm install",
    "bun install",
    "pnpm install",
    "yarn add left-pad",
    "go get example.com/mod",
  ])("network-bearing developer command mints network_request: %j", async (command: string) => {
    const envelope = await evaluate(command)
    expect(envelope.capabilities.some((c: any) => c.class === "network_request")).toBe(true)
  })

  test("sandbox network mode is full after a network capability is granted", async () => {
    const gate = await EnforcementGate.create({
      activeWorkspace: WORKSPACE,
      workspaceType: "worktree",
      profileId: "autonomous",
    })
    const envelope = gate.evaluate("bash", { command: "curl -sS https://example.com", workdir: WORKSPACE })
    expect(envelope.decision).toBe("allow")
    expect(gate.getSandboxPolicy()?.network.mode).toBe("full")
  })

  test("sandbox network mode stays restricted without a network capability", async () => {
    const gate = await EnforcementGate.create({
      activeWorkspace: WORKSPACE,
      workspaceType: "worktree",
      profileId: "autonomous",
    })
    const envelope = gate.evaluate("bash", { command: "git status", workdir: WORKSPACE })
    expect(envelope.decision).toBe("allow")
    expect(gate.getSandboxPolicy()?.network.mode).toBe("restricted")
  })
})
