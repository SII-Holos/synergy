import { afterEach, describe, expect, test } from "bun:test"
import { StoragePath } from "../../src/storage/path"
import { Storage } from "../../src/storage/storage"
import { SynergyLinkTargetStore } from "../../src/synergy-link/target-store"

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

  test("skips malformed records without hiding healthy targets", async () => {
    const created = await SynergyLinkTargetStore.create({
      name: "Linux Host",
      targetAgentID: "agent_linux",
      linkID: "link_linux",
    })
    await Storage.write(StoragePath.synergyLinkTarget("target_malformed"), { name: 42 })

    expect(await SynergyLinkTargetStore.list()).toEqual([created])
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
})
