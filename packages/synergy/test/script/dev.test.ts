import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
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
    expect(plan.processes.map((process) => process.label)).toEqual(["server", "app", "browser-host"])
    expect(plan.processes[0]?.env).toMatchObject({
      SYNERGY_CWD: "/workspace",
    })
    expect(plan.processes[0]?.waitTimeoutMs).toBeNull()
    expect(plan.processes[1]?.env).toMatchObject({
      VITE_SYNERGY_SERVER_URL: "http://127.0.0.1:4096",
      VITE_SYNERGY_CALLBACK_URL: "http://127.0.0.1:4096/holos/callback",
    })
    expect(plan.processes[1]?.command).toContain("--strictPort")
    expect(plan.processes[2]?.command).toEqual(["/bun", "run", "browser-host:dev"])
    expect(plan.processes[2]?.env?.SYNERGY_BROWSER_HOST_SERVER_URL).toBe("http://127.0.0.1:4096")
    expect(plan.processes[2]?.env?.SYNERGY_BROWSER_HOST_REGISTRATION_SECRET).toBe(
      plan.processes[0]?.env?.SYNERGY_BROWSER_HOST_REGISTRATION_SECRET,
    )
  })

  test("plans desktop development in external mode by default", () => {
    const plan = createDevPlan(["desktop"], options)

    expect(plan.kind).toBe("run")
    expect(plan.processes.map((process) => process.label)).toEqual(["server", "app", "desktop"])
    expect(plan.processes[2]?.env).toMatchObject({
      BUN_BIN: "/bun",
      SYNERGY_DESKTOP_CHANNEL: "dev",
      SYNERGY_DESKTOP_SERVER_MODE: "external",
      SYNERGY_DESKTOP_APP_URL: "http://127.0.0.1:3000",
      SYNERGY_BROWSER_BROKER_SERVER_URL: "http://127.0.0.1:4096",
    })
    expect(plan.processes[2]?.env?.SYNERGY_BROWSER_HOST_REGISTRATION_SECRET).toBe(
      plan.processes[0]?.env?.SYNERGY_BROWSER_HOST_REGISTRATION_SECRET,
    )
  })

  test("does not register a native broker when Desktop attaches to a remote server", () => {
    const plan = createDevPlan(["desktop", "--attach", "https://remote.example"], options)

    expect(plan.processes.map((process) => process.label)).toEqual(["app", "desktop"])
    expect(plan.requiredServers).toEqual(["https://remote.example"])
    expect(plan.processes[1]?.env?.SYNERGY_BROWSER_BROKER_SERVER_URL).toBeUndefined()
    expect(plan.processes[1]?.env?.SYNERGY_BROWSER_HOST_REGISTRATION_SECRET).toBeUndefined()
  })

  test("plans managed desktop with install and app build when dependencies are missing", () => {
    const plan = createDevPlan(["desktop", "--managed"], options)

    expect(plan.kind).toBe("run")
    expect(plan.mode).toBe("serial")
    expect(plan.processes.map((process) => process.label)).toEqual(["install", "build:plugin", "build", "desktop"])
    expect(plan.processes[3]?.env).toMatchObject({
      BUN_BIN: "/bun",
      SYNERGY_DESKTOP_CHANNEL: "dev",
      SYNERGY_DESKTOP_SERVER_MODE: "managed",
    })
    expect(plan.processes[3]?.env).not.toHaveProperty("SYNERGY_DESKTOP_APP_URL")
  })

  test("plans managed desktop with app build even when app/dist already exists", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "synergy-dev-plan-"))
    try {
      await mkdir(path.join(repoRoot, "node_modules"), { recursive: true })
      await mkdir(path.join(repoRoot, "packages", "app", "dist"), { recursive: true })
      await writeFile(path.join(repoRoot, "packages", "app", "dist", "index.html"), "<!doctype html>")

      const plan = createDevPlan(["desktop", "--managed"], { ...options, repoRoot })

      expect(plan.kind).toBe("run")
      expect(plan.mode).toBe("serial")
      expect(plan.processes.map((process) => process.label)).toEqual(["build:plugin", "build", "desktop"])
      expect(plan.processes[1]?.command).toEqual(["/bun", "run", "build"])
      expect(plan.processes[1]?.cwd).toBe(path.join(repoRoot, "packages", "app"))
      expect(plan.processes[2]?.env).toMatchObject({
        BUN_BIN: "/bun",
        SYNERGY_DESKTOP_CHANNEL: "dev",
        SYNERGY_DESKTOP_SERVER_MODE: "managed",
      })
      expect(plan.processes[2]?.env).not.toHaveProperty("SYNERGY_DESKTOP_APP_URL")
    } finally {
      await rm(repoRoot, { recursive: true, force: true })
    }
  })

  test("requires an explicit build target", () => {
    const plan = createDevPlan(["build"], options)

    expect(plan.kind).toBe("error")
    expect(plan.message).toContain("bun dev build app|desktop")
  })
})
