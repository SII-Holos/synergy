import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import process from "node:process"
import { SynergyLinkControlClient } from "../src/control/client"
import { SynergyLinkRuntime } from "../src/runtime"
import { SynergyLinkLog } from "../src/log"
import { ControlRequestSchema } from "../src/control/schema"

const originalHome = process.env.SYNERGY_LINK_HOME
const tempRoots: string[] = []

beforeEach(async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "synergy-link-control-test-"))
  tempRoots.push(root)
  process.env.SYNERGY_LINK_HOME = root
})

afterAll(async () => {
  await SynergyLinkLog.flush()
  if (originalHome === undefined) {
    delete process.env.SYNERGY_LINK_HOME
  } else {
    process.env.SYNERGY_LINK_HOME = originalHome
  }
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
})

describe("synergy-link control socket", () => {
  test("exposes runtime control actions over the local socket", async () => {
    const runtime = await SynergyLinkRuntime.create()
    await runtime.control.start()
    try {
      expect(await SynergyLinkControlClient.isAvailable()).toBe(true)
      expect(ControlRequestSchema.safeParse({ action: "synergy_link.execute", caller: {}, body: {} }).success).toBe(
        false,
      )
      if (process.platform !== "win32") {
        expect((await stat(runtime.control.socketPath)).mode & 0o777).toBe(0o600)
        expect((await stat(process.env.SYNERGY_LINK_HOME!)).mode & 0o777).toBe(0o700)
      }

      const mode = await SynergyLinkControlClient.request<{
        mode: string
        ownership: { local: { owned: boolean; activeOwnerID: string | null } }
      }>({ action: "runtime.mode" })
      expect(mode.mode).toBe("standalone")
      expect(mode.ownership.local.owned).toBe(false)

      const approval = await SynergyLinkControlClient.request<{ mode: string }>({ action: "approval.get" })
      expect(approval.mode).toBe("manual")

      const managed = await SynergyLinkControlClient.request<{
        mode: string
        ownership: { local: { owned: boolean; activeOwnerID: string | null } }
        connectionStatus: string
      }>({ action: "runtime.enter_managed" })
      expect(managed.mode).toBe("managed")
      expect(managed.ownership.local.owned).toBe(true)
      expect(managed.ownership.local.activeOwnerID).toMatch(/^link_/)

      expect(managed.connectionStatus).toBe("disconnected")

      const standalone = await SynergyLinkControlClient.request<{
        mode: string
        ownership: { local: { owned: boolean; activeOwnerID: string | null } }
        connectionStatus: string
      }>({ action: "runtime.set_mode", mode: "standalone" })
      expect(standalone.mode).toBe("standalone")
      expect(standalone.ownership.local.owned).toBe(false)

      const managedAgain = await SynergyLinkControlClient.request<{
        mode: string
        ownership: { local: { owned: boolean; activeOwnerID: string | null } }
        connectionStatus: string
      }>({ action: "runtime.enter_managed" })
      expect(managedAgain.mode).toBe("managed")
      expect(managedAgain.ownership.local.owned).toBe(true)

      await SynergyLinkControlClient.request({ action: "approval.set", mode: "trusted-only" })
      const collaboration = await SynergyLinkControlClient.request<{ enabled: boolean; approvalMode: string }>({
        action: "collaboration.status",
      })
      expect(collaboration.enabled).toBe(true)
      expect(collaboration.approvalMode).toBe("trusted-only")

      const label = await SynergyLinkControlClient.request<{ label: string | null }>({
        action: "label.set",
        label: "local test",
      })
      expect(label.label).toBe("local test")

      const trust = await SynergyLinkControlClient.request<{ agents: string[] }>({
        action: "trust.add",
        subject: "agent",
        value: "agent_test",
      })
      expect(trust.agents).toContain("agent_test")
    } finally {
      await runtime.stopServerProcess()
    }
  })

  test("keeps control socket paths out of private runtime logs", async () => {
    const runtime = await SynergyLinkRuntime.create()
    await runtime.control.start()
    await runtime.control.stop()
    await SynergyLinkLog.flush()

    const logPath = path.join(process.env.SYNERGY_LINK_HOME!, "logs", "runtime.log")
    for (let attempt = 0; attempt < 50 && !(await Bun.file(logPath).exists()); attempt++) await Bun.sleep(10)
    const log = await readFile(logPath, "utf8")
    expect(log).not.toContain(path.join(process.env.SYNERGY_LINK_HOME!, "control.sock"))
    expect((await stat(logPath)).mode & 0o777).toBe(0o600)
  })
})
