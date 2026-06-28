import { describe, expect, test } from "bun:test"
import { createDevPlan } from "../../../../script/dev"

const options = { repoRoot: "/repo", cwd: "/workspace", bunPath: "/bun" }

describe("dev orchestrator planner", () => {
  test("shows help when no command is provided", () => {
    const plan = createDevPlan([], options)

    expect(plan.kind).toBe("help")
    expect(plan.help).toContain("bun dev <command>")
  })

  test("plans the web workflow as server plus app with browser open", () => {
    const plan = createDevPlan(["web"], options)

    expect(plan.kind).toBe("run")
    expect(plan.openUrl).toBe("http://127.0.0.1:3000")
    expect(plan.requiredPorts).toEqual([
      { label: "server", port: 4096, host: "127.0.0.1" },
      { label: "app", port: 3000, host: "127.0.0.1" },
    ])
    expect(plan.processes.map((process) => process.label)).toEqual(["server", "app"])
    expect(plan.processes[0]?.env).toMatchObject({
      SYNERGY_CWD: "/workspace",
    })
    expect(plan.processes[1]?.env).toMatchObject({
      VITE_SYNERGY_SERVER_URL: "http://127.0.0.1:4096",
      VITE_SYNERGY_CALLBACK_URL: "http://127.0.0.1:4096/holos/callback",
    })
    expect(plan.processes[1]?.command).toContain("--strictPort")
  })

  test("plans desktop development in external mode by default", () => {
    const plan = createDevPlan(["desktop"], options)

    expect(plan.kind).toBe("run")
    expect(plan.processes.map((process) => process.label)).toEqual(["server", "app", "desktop"])
    expect(plan.processes[2]?.env).toMatchObject({
      SYNERGY_DESKTOP_CHANNEL: "dev",
      SYNERGY_DESKTOP_SERVER_MODE: "external",
      SYNERGY_DESKTOP_APP_URL: "http://127.0.0.1:3000",
    })
  })

  test("plans managed desktop without server or app processes", () => {
    const plan = createDevPlan(["desktop", "--managed"], options)

    expect(plan.kind).toBe("run")
    expect(plan.processes.map((process) => process.label)).toEqual(["desktop"])
    expect(plan.processes[0]?.env).toMatchObject({
      SYNERGY_DESKTOP_CHANNEL: "dev",
      SYNERGY_DESKTOP_SERVER_MODE: "managed",
    })
    expect(plan.processes[0]?.env).not.toHaveProperty("SYNERGY_DESKTOP_APP_URL")
  })

  test("requires an explicit build target", () => {
    const plan = createDevPlan(["build"], options)

    expect(plan.kind).toBe("error")
    expect(plan.message).toContain("bun dev build app|desktop")
  })
})
