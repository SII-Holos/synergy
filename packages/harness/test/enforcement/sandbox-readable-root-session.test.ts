import { describe, expect, test } from "bun:test"
import { $ } from "bun"
import * as fs from "node:fs"
import * as path from "node:path"
const { EnforcementGate } = await import("../../src/enforcement/gate")
const { controlledTempRoot } = await import("../../src/sandbox/policy")
const { tmpdir } = await import("../support/fixture")

// ---------------------------------------------------------------------------
// PR #1308 follow-up anchors:
// - EnforcementGate.create threads sessionKey into profile resolution, so the
//   autonomous controlled temp root is session-scoped
//   (<ws>/.synergy/tmp/synergy-<pid>-<sessionKey>) instead of the shared base
//   root — concurrent sessions cannot see each other's sandbox temp files.
// - A gate-approved external read (autonomous auto-allowed file_external_read)
//   lands in the aggregated sandbox readable roots, so the bash wrapper can
//   forward it into the OS sandbox.
// ---------------------------------------------------------------------------

describe("sandbox readable roots and session key (PR #1308 follow-up)", () => {
  test("autonomous sessionKey scopes the controlled temporary writable root", async () => {
    await using tmp = await tmpdir()
    const workspace = tmp.path
    const gate = await EnforcementGate.create({
      activeWorkspace: workspace,
      workspaceType: "worktree",
      profileId: "autonomous",
      sessionKey: "ses_abc",
    })
    const policy = gate.getSandboxPolicy()
    expect(policy).not.toBeNull()
    expect(policy!.fileSystem.writableRoots).toContain(controlledTempRoot(workspace, "ses_abc"))
    expect(policy!.fileSystem.writableRoots).not.toContain(controlledTempRoot(workspace))
  })

  test("gate-approved external read lands in the sandbox readable roots", async () => {
    if (!fs.existsSync("/etc/hosts")) return
    await using tmp = await tmpdir()
    const workspace = tmp.path
    const gate = await EnforcementGate.create({
      activeWorkspace: workspace,
      workspaceType: "worktree",
      profileId: "autonomous",
      sessionKey: "ses_abc",
    })
    const envelope = gate.evaluate("bash", { command: "cat /etc/hosts", workdir: workspace })
    expect(envelope.decision).toBe("allow")
    const policy = gate.getSandboxPolicy()
    expect(policy).not.toBeNull()
    expect(policy!.fileSystem.readableRoots).toContain("/etc/hosts")
  })

  test("worktree session does not implicitly authorize original checkout Git metadata", async () => {
    await using tmp = await tmpdir()
    const main = tmp.path
    const worktree = path.join(main, ".synergy", "worktrees", "feature-x")
    fs.mkdirSync(worktree, { recursive: true })
    fs.mkdirSync(path.join(main, ".git"), { recursive: true })
    const gate = await EnforcementGate.create({
      activeWorkspace: worktree,
      workspaceType: "worktree",
      profileId: "autonomous",
      sessionKey: "ses_abc",
      originalCheckout: main,
    })
    const policy = gate.getSandboxPolicy()
    expect(policy).not.toBeNull()
    expect(policy!.fileSystem.readableRoots).not.toContain(path.join(main, ".git"))
    expect(policy!.fileSystem.writableRoots).not.toContain(path.join(main, ".git"))
  })

  test("main sessions do not seed a git directory sandbox root", async () => {
    await using tmp = await tmpdir()
    const gate = await EnforcementGate.create({
      activeWorkspace: tmp.path,
      workspaceType: "main",
      profileId: "autonomous",
      sessionKey: "ses_abc",
    })
    const policy = gate.getSandboxPolicy()
    expect(policy).not.toBeNull()
    expect(policy!.fileSystem.readableRoots).not.toContain(path.join(tmp.path, ".git"))
  })
})

describe("worktree gitdir enumerated sandbox grants", () => {
  async function linkedWorktree(main: string) {
    await $`git init -q`.cwd(main).quiet()
    await $`git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init`.cwd(main).quiet()
    const wt = path.join(main, "wt")
    await $`git worktree add -q ${wt} -b feature`.cwd(main).quiet()
    return wt
  }

  test("linked worktree seeds enumerated gitdir file grants without directory roots", async () => {
    await using tmp = await tmpdir()
    const main = fs.realpathSync(tmp.path)
    const wt = await linkedWorktree(main)
    await $`git pack-refs --all`.cwd(main).quiet()
    fs.writeFileSync(path.join(main, ".git", "info", "exclude"), "secret-local.txt\n")
    const gate = await EnforcementGate.create({
      activeWorkspace: wt,
      workspaceType: "worktree",
      profileId: "autonomous",
      sessionKey: "ses_abc",
      originalCheckout: main,
    })
    const policy = gate.getSandboxPolicy()
    expect(policy).not.toBeNull()
    const roots = policy!.fileSystem.readableRoots
    const meta = path.join(main, ".git", "worktrees", "wt")
    for (const file of ["HEAD", "commondir", "gitdir"]) {
      expect(roots).toContain(path.join(meta, file))
    }
    for (const file of ["index", "ORIG_HEAD", "config.worktree"]) {
      if (fs.existsSync(path.join(meta, file))) expect(roots).toContain(path.join(meta, file))
    }
    expect(roots).not.toContain(meta)
    expect(roots).not.toContain(path.join(meta, "logs"))
    expect(roots).toContain(path.join(main, ".git", "objects"))
    expect(roots).toContain(path.join(main, ".git", "refs"))
    expect(roots).toContain(path.join(main, ".git", "config"))
    expect(roots).toContain(path.join(main, ".git", "packed-refs"))
    expect(roots).toContain(path.join(main, ".git", "info", "exclude"))
    expect(roots).not.toContain(path.join(main, ".git"))
    expect(roots).not.toContain(path.join(main, ".git", "hooks"))
    const neverWritable = [
      meta,
      path.join(main, ".git", "objects"),
      path.join(main, ".git", "refs"),
      path.join(main, ".git", "config"),
      path.join(main, ".git", "packed-refs"),
    ]
    for (const grant of neverWritable) {
      expect(policy!.fileSystem.writableRoots).not.toContain(grant)
    }
  })

  test("pointer aimed at a sibling worktree metadata entry yields no grants", async () => {
    await using tmp = await tmpdir()
    const main = fs.realpathSync(tmp.path)
    const wt = await linkedWorktree(main)
    const fake = path.join(main, "fake-wt")
    fs.mkdirSync(fake, { recursive: true })
    fs.writeFileSync(path.join(fake, ".git"), `gitdir: ${path.join(main, ".git", "worktrees", "wt")}\n`)
    const gate = await EnforcementGate.create({
      activeWorkspace: fake,
      workspaceType: "worktree",
      profileId: "autonomous",
      sessionKey: "ses_abc",
      originalCheckout: main,
    })
    const policy = gate.getSandboxPolicy()
    expect(policy).not.toBeNull()
    const roots = policy!.fileSystem.readableRoots
    expect(roots).not.toContain(path.join(main, ".git", "worktrees", "wt", "HEAD"))
    expect(roots).not.toContain(path.join(main, ".git", "objects"))
    expect(wt).toBeTruthy()
  })

  test("gitdir pointer escaping the checkout metadata root yields no grants", async () => {
    await using tmp = await tmpdir()
    const main = tmp.path
    fs.mkdirSync(path.join(main, ".git", "worktrees"), { recursive: true })
    const fake = path.join(main, "fake-wt")
    fs.mkdirSync(fake, { recursive: true })
    fs.writeFileSync(path.join(fake, ".git"), `gitdir: ${path.join(main, "elsewhere", "wt")}\n`)
    const gate = await EnforcementGate.create({
      activeWorkspace: fake,
      workspaceType: "worktree",
      profileId: "autonomous",
      sessionKey: "ses_abc",
      originalCheckout: main,
    })
    const policy = gate.getSandboxPolicy()
    expect(policy).not.toBeNull()
    expect(policy!.fileSystem.readableRoots).not.toContain(path.join(main, "elsewhere", "wt"))
    expect(policy!.fileSystem.readableRoots).not.toContain(path.join(main, ".git", "objects"))
  })

  test("commondir resolving outside the checkout .git yields no grants", async () => {
    await using tmp = await tmpdir()
    const main = tmp.path
    const meta = path.join(main, ".git", "worktrees", "wt")
    fs.mkdirSync(meta, { recursive: true })
    const fake = path.join(main, "fake-wt")
    fs.mkdirSync(fake, { recursive: true })
    fs.writeFileSync(path.join(fake, ".git"), `gitdir: ${meta}\n`)
    fs.writeFileSync(path.join(meta, "commondir"), "../../elsewhere\n")
    const gate = await EnforcementGate.create({
      activeWorkspace: fake,
      workspaceType: "worktree",
      profileId: "autonomous",
      sessionKey: "ses_abc",
      originalCheckout: main,
    })
    const policy = gate.getSandboxPolicy()
    expect(policy).not.toBeNull()
    expect(policy!.fileSystem.readableRoots).not.toContain(path.join(main, ".git", "objects"))
  })

  test("worktree-typed session on a non-linked directory yields no grants", async () => {
    await using tmp = await tmpdir()
    const main = tmp.path
    fs.mkdirSync(path.join(main, ".git"), { recursive: true })
    const gate = await EnforcementGate.create({
      activeWorkspace: main,
      workspaceType: "worktree",
      profileId: "autonomous",
      sessionKey: "ses_abc",
      originalCheckout: main,
    })
    const policy = gate.getSandboxPolicy()
    expect(policy).not.toBeNull()
    expect(policy!.fileSystem.readableRoots).not.toContain(path.join(main, ".git", "config"))
  })
})
