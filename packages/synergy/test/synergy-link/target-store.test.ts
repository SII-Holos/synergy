import { afterEach, describe, expect, test } from "bun:test"
import type {
  SynergyLinkBash,
  SynergyLinkClient,
  SynergyLinkProcess,
  SynergyLinkSession,
} from "@ericsanchezok/synergy-link-protocol"
import { SynergyLinkTarget } from "../../src/synergy-link/types"
import { SynergyLinkTargetRuntime } from "../../src/synergy-link/target-runtime"
import { SynergyLinkTargetStore } from "../../src/synergy-link/target-store"
import { StoragePath } from "../../src/storage/path"
import { Storage } from "../../src/storage/storage"
import { SynergyLinkExecution } from "../../src/tool/synergy-link-execution"

afterEach(async () => {
  await Storage.removeTree(StoragePath.synergyLinkTargetsRoot())
})

describe("Synergy Link target store", () => {
  test("persists targets across independent reads", async () => {
    const created = await SynergyLinkTargetStore.create({
      name: "Build Mac",
      targetAgentID: "agent_build_mac",
      linkID: "link_build_mac",
    })

    expect(await SynergyLinkTargetStore.get(created.id)).toEqual(created)
    expect(await SynergyLinkTargetStore.list()).toEqual([created])
  })

  test("reports malformed records instead of silently hiding them", async () => {
    await SynergyLinkTargetStore.create({
      name: "Linux Host",
      targetAgentID: "agent_linux",
      linkID: "link_linux",
    })
    await Storage.write(StoragePath.synergyLinkTarget("target_malformed"), { name: 42 })

    await expect(SynergyLinkTargetStore.list()).rejects.toThrow("Invalid persisted Synergy Link target")
  })

  test("updates and removes one target without rewriting peers", async () => {
    const first = await SynergyLinkTargetStore.create({
      name: "First",
      targetAgentID: "agent_first",
      linkID: "link_first",
    })
    const second = await SynergyLinkTargetStore.create({
      name: "Second",
      targetAgentID: "agent_second",
      linkID: "link_second",
    })

    const updated = await SynergyLinkTargetStore.update(first.id, { name: "Primary", enabled: false })
    expect(updated.name).toBe("Primary")
    expect(updated.enabled).toBe(false)
    expect(await SynergyLinkTargetStore.get(second.id)).toEqual(second)

    await SynergyLinkTargetStore.remove(first.id)
    expect(await SynergyLinkTargetStore.get(first.id)).toBeUndefined()
    expect(await SynergyLinkTargetStore.list()).toEqual([second])
  })

  test("rejects targets that reuse an existing linkID", async () => {
    await SynergyLinkTargetStore.create({
      name: "First host",
      targetAgentID: "agent_first",
      linkID: "link_shared",
    })

    await expect(
      SynergyLinkTargetStore.create({
        name: "Second host",
        targetAgentID: "agent_second",
        linkID: "link_shared",
      }),
    ).rejects.toThrow("already exists")
  })

  test("records an explicit refusal after approval as revoked", async () => {
    const target = await SynergyLinkTargetStore.create({
      name: "Revoked host",
      targetAgentID: "agent_revoked",
      linkID: "link_revoked",
    })

    const approved = await SynergyLinkTargetStore.recordProbe(target.id, { status: "reachable" })
    expect(approved.authorization).toBe("approved")

    const revoked = await SynergyLinkTargetStore.recordProbe(target.id, { status: "refused" })
    expect(revoked.authorization).toBe("revoked")
  })
})

describe("Synergy Link target relink", () => {
  test("accepts a relink only when both locator fields are supplied together", async () => {
    const target = await SynergyLinkTargetStore.create({
      name: "Relink host",
      targetAgentID: "agent_old",
      linkID: "link_old",
    })

    await expect(SynergyLinkTargetStore.update(target.id, { targetAgentID: "agent_new" })).rejects.toThrow(
      "targetAgentID and linkID must be updated together",
    )
    await expect(SynergyLinkTargetStore.update(target.id, { linkID: "link_new" })).rejects.toThrow(
      "targetAgentID and linkID must be updated together",
    )

    const relinked = await SynergyLinkTargetStore.update(target.id, {
      targetAgentID: "agent_new",
      linkID: "link_new",
    })
    expect(relinked.targetAgentID).toBe("agent_new")
    expect(relinked.linkID).toBe("link_new")
    expect(relinked.name).toBe("Relink host")
  })

  test("rejects a relink whose new locator collides with another target", async () => {
    const first = await SynergyLinkTargetStore.create({
      name: "First",
      targetAgentID: "agent_first",
      linkID: "link_first",
    })
    const second = await SynergyLinkTargetStore.create({
      name: "Second",
      targetAgentID: "agent_second",
      linkID: "link_second",
    })

    await expect(
      SynergyLinkTargetStore.update(second.id, {
        targetAgentID: "agent_first",
        linkID: "link_first",
      }),
    ).rejects.toThrow("already in use")
    const unchanged = await SynergyLinkTargetStore.require(second.id)
    expect(unchanged.targetAgentID).toBe("agent_second")
    expect(unchanged.linkID).toBe("link_second")
    expect(await SynergyLinkTargetStore.require(first.id)).toEqual(first)
  })
})

describe("Synergy Link target availability", () => {
  test("reports unknown availability when the Holos transport is not connected", async () => {
    SynergyLinkExecution.setClient(null)
    const target = await SynergyLinkTargetStore.create({
      name: "Offline host",
      targetAgentID: "agent_offline",
      linkID: "link_offline",
    })

    const observed = SynergyLinkTargetRuntime.view(target)
    expect(observed.availability).toBe("unknown")
    expect(observed.lastProbe).toBeUndefined()
  })

  test("reports unreachable when a client exists but no session is open and no probe succeeded", async () => {
    SynergyLinkExecution.setClient({
      executeBash: async (): Promise<SynergyLinkBash.Result> => {
        throw new Error("unexpected bash execution")
      },
      executeProcess: async (): Promise<SynergyLinkProcess.Result> => {
        throw new Error("unexpected process execution")
      },
      executeSession: async (): Promise<SynergyLinkSession.Result> => {
        throw new Error("unexpected session execution")
      },
    })
    const target = await SynergyLinkTargetStore.create({
      name: "Client host",
      targetAgentID: "agent_client",
      linkID: "link_client",
    })

    const observed = SynergyLinkTargetRuntime.view(target)
    expect(observed.availability).toBe("unreachable")
    expect(SynergyLinkTarget.Availability.safeParse(observed.availability).success).toBe(true)
  })
})
