import { describe, expect, test } from "bun:test"
import path from "path"
import { buildPermissionContext } from "../../src/session/permission-context"
import { SystemPrompt } from "../../src/session/system"
import { ScopeContext } from "../../src/scope/context"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"
import { $ } from "bun"

Log.init({ print: false })

function profile() {
  return {
    valid: true,
    label: "Guarded",
    description: "Test",
    ruleset: [],
    filesystem: { readRoots: [], writeRoots: [], protectedPaths: [] },
    network: { mode: "restricted" as const },
    sandbox: { mode: "workspace_write" as const, fallback: "warn" as const },
    approval: {
      mode: "guarded" as const,
      lowRisk: "allow" as const,
      mediumRisk: "ask" as const,
      highRisk: "ask" as const,
    },
    summary: {
      profileId: "guarded" as const,
      sandbox: { mode: "workspace_write" as const, fallback: "warn" as const },
      label: "Guarded",
      brief: "Test",
      approval: {
        mode: "guarded" as const,
        lowRisk: "allow" as const,
        mediumRisk: "ask" as const,
        highRisk: "ask" as const,
      },
      deniedCapabilities: [],
      workspaceRoot: "/",
    },
  }
}

describe("buildPermissionContext with multiple roots", () => {
  test("renders all workspace roots in the permission profile", () => {
    const text = buildPermissionContext(profile() as any, ["/project/main", "/project/folder-a"])
    expect(text).toContain("Workspace roots: /project/main, /project/folder-a")
    expect(text).toContain('<permission_profile id="guarded"')
  })

  test("renders a single root without commas", () => {
    const text = buildPermissionContext(profile() as any, ["/project/main"])
    expect(text).toContain("Workspace roots: /project/main")
  })
})

describe("SystemPrompt.environment with project folders", () => {
  test("lists project folders when a project scope declares sandboxes", async () => {
    await using tmp = await tmpdir()
    const folder = path.join(tmp.path, "folder-a")
    await $`mkdir -p ${folder}`.quiet()

    const scope: import("../../src/scope").Scope.Project = {
      type: "project",
      id: "d_test",
      directory: tmp.path,
      worktree: tmp.path,
      vcs: "git",
      name: "Test",
      sandboxes: [folder],
      time: { created: 0, updated: 0 },
    }

    const [text] = await ScopeContext.provide({
      scope,
      fn: () => SystemPrompt.environment(),
    })
    expect(text).toContain(`Project folders: ${tmp.path}, ${folder}`)
    expect(text).toContain(`Working directory: ${tmp.path}`)
  })

  test("renders a single project folder line for a plain project", async () => {
    await using tmp = await tmpdir()
    const scope: import("../../src/scope").Scope.Project = {
      type: "project",
      id: "d_test",
      directory: tmp.path,
      worktree: tmp.path,
      vcs: "git",
      name: "Test",
      sandboxes: [],
      time: { created: 0, updated: 0 },
    }

    const [text] = await ScopeContext.provide({
      scope,
      fn: () => SystemPrompt.environment(),
    })
    expect(text).toContain(`Project folder: ${tmp.path}`)
  })

  test("does not add a project folder line for the home scope", async () => {
    const scope = {
      type: "home" as const,
      id: "home" as const,
      directory: "/home/test",
      worktree: "/home/test",
    }
    const [text] = await ScopeContext.provide({
      scope,
      fn: () => SystemPrompt.environment(),
    })
    expect(text).not.toContain("Project folders:")
    expect(text).not.toContain("Project folder:")
  })
})
