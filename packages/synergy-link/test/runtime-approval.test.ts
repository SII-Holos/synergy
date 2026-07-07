import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import process from "node:process"
import { SynergyLinkCLIBackend } from "../src/cli-backend"
import { SynergyLinkRuntime } from "../src/runtime"

const originalHome = process.env.SYNERGY_LINK_HOME
const tempRoots: string[] = []

beforeEach(async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "synergy-link-test-"))
  tempRoots.push(root)
  process.env.SYNERGY_LINK_HOME = root
})

afterAll(async () => {
  if (originalHome === undefined) {
    delete process.env.SYNERGY_LINK_HOME
  } else {
    process.env.SYNERGY_LINK_HOME = originalHome
  }
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
})

describe("synergy-link runtime approval", () => {
  test("manual mode queues requests until CLI approval", async () => {
    const runtime = await SynergyLinkRuntime.create()

    const first = await runtime.decideSessionOpen({
      caller: { agentID: "agent_a", ownerUserID: 1 },
      label: "hello",
    })
    expect(first).toBe("pending")

    const listed = await SynergyLinkCLIBackend.listRequests()
    expect(listed.available).toBe(true)
    if (!listed.available) return
    expect(listed.value.requests).toHaveLength(1)
    expect(listed.value.requests[0]?.status).toBe("pending")

    const approved = await SynergyLinkCLIBackend.approveRequest(listed.value.requests[0]!.id)
    expect(approved.available).toBe(true)

    const second = await runtime.decideSessionOpen({
      caller: { agentID: "agent_a", ownerUserID: 1 },
      label: "hello again",
    })
    expect(second).toBe("approve")

    const third = await runtime.decideSessionOpen({
      caller: { agentID: "agent_a", ownerUserID: 1 },
      label: "needs another approval",
    })
    expect(third).toBe("pending")
  })

  test("trusted identities and trusted-only mode auto-approve matching callers", async () => {
    await SynergyLinkCLIBackend.setApproval("trusted-only")
    await SynergyLinkCLIBackend.addTrust("agent", "agent_trusted")
    await SynergyLinkCLIBackend.addTrust("user", "42")

    const runtime = await SynergyLinkRuntime.create()

    await expect(runtime.decideSessionOpen({ caller: { agentID: "agent_trusted", ownerUserID: 7 } })).resolves.toBe(
      "approve",
    )

    await expect(runtime.decideSessionOpen({ caller: { agentID: "agent_other", ownerUserID: 42 } })).resolves.toBe(
      "approve",
    )

    await expect(runtime.decideSessionOpen({ caller: { agentID: "agent_other", ownerUserID: 99 } })).resolves.toBe(
      "pending",
    )
  })
})
