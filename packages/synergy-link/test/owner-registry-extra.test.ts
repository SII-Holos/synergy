import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import process from "node:process"
import { SynergyLinkOwnerRegistry } from "../src/owner-registry"

const originalHome = process.env.SYNERGY_LINK_HOME
const tempRoots: string[] = []

afterEach(async () => {
  if (originalHome === undefined) delete process.env.SYNERGY_LINK_HOME
  else process.env.SYNERGY_LINK_HOME = originalHome
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("synergy-link owner registry", () => {
  test("hydrates legacy synergy owner records", () => {
    const byAgentId = SynergyLinkOwnerRegistry.hydrate({ owner: "old", agentId: "agent_9", version: 1 })
    expect(byAgentId.local.activeOwnerID).toBe("synergy:agent_9")
    expect(byAgentId.local.ownerIDs).toEqual(["synergy:agent_9"])

    const byOwner = SynergyLinkOwnerRegistry.hydrate({ owner: "synergy:old", version: 0 })
    expect(byOwner.local.activeOwnerID).toBe("synergy:old")

    const invalidVersion = SynergyLinkOwnerRegistry.hydrate({ owner: "x", version: "not-a-number" })
    expect(invalidVersion.local.ownerIDs).toEqual([])
  })

  test("hydrates modern registries and prepends a missing active owner", () => {
    const parsed = SynergyLinkOwnerRegistry.hydrate({
      local: { ownerIDs: ["synergy:a"], activeOwnerID: "synergy:missing", leaseExpiresAt: 42 },
    })
    expect(parsed.local.ownerIDs).toEqual(["synergy:missing", "synergy:a"])
    expect(parsed.local.activeOwnerID).toBe("synergy:missing")
    expect(parsed.local.leaseExpiresAt).toBe(42)

    const invalidLease = SynergyLinkOwnerRegistry.hydrate({ local: { leaseExpiresAt: Number.NaN } })
    expect(invalidLease.local.leaseExpiresAt).toBeUndefined()

    expect(SynergyLinkOwnerRegistry.hydrate("garbage").local.ownerIDs).toEqual([])
  })

  test("declareLocalOwner trims ids, deduplicates, and rejects blank owners", () => {
    const registry = SynergyLinkOwnerRegistry.defaultRegistry()
    const first = SynergyLinkOwnerRegistry.declareLocalOwner(registry, "  synergy:me  ", {
      leaseExpiresAt: Date.now() + 1000,
    })
    expect(first.local.activeOwnerID).toBe("synergy:me")
    expect(first.local.owned).toBe(true)

    SynergyLinkOwnerRegistry.declareLocalOwner(registry, "synergy:me")
    expect(registry.local.ownerIDs.filter((id) => id === "synergy:me")).toHaveLength(1)

    expect(() => SynergyLinkOwnerRegistry.declareLocalOwner(registry, "   ")).toThrow("Owner ID is required")
    expect(() => SynergyLinkOwnerRegistry.declareLocalOwner(registry, "x", { leaseExpiresAt: Number.NaN })).toThrow(
      "finite timestamp",
    )
  })

  test("releaseLocalOwner only releases matching or absent owners", () => {
    const registry = SynergyLinkOwnerRegistry.defaultRegistry()
    SynergyLinkOwnerRegistry.declareLocalOwner(registry, "synergy:me")
    SynergyLinkOwnerRegistry.releaseLocalOwner(registry, "synergy:other")
    expect(registry.local.activeOwnerID).toBe("synergy:me")

    const released = SynergyLinkOwnerRegistry.releaseLocalOwner(registry, "synergy:me")
    expect(released.local.activeOwnerID).toBeNull()
    expect(released.local.leaseExpiresAt).toBeNull()

    SynergyLinkOwnerRegistry.declareLocalOwner(registry, "synergy:me")
    SynergyLinkOwnerRegistry.releaseLocalOwner(registry)
    expect(registry.local.activeOwnerID).toBeUndefined()
  })

  test("tracks active ownership and lease expiry", () => {
    const registry = SynergyLinkOwnerRegistry.defaultRegistry()
    expect(SynergyLinkOwnerRegistry.hasActiveLocalOwner(registry)).toBe(false)
    expect(SynergyLinkOwnerRegistry.activeOwnerExpired(registry)).toBe(false)

    SynergyLinkOwnerRegistry.declareLocalOwner(registry, "synergy:me", { leaseExpiresAt: Date.now() + 1000 })
    expect(SynergyLinkOwnerRegistry.hasActiveLocalOwner(registry)).toBe(true)
    expect(SynergyLinkOwnerRegistry.activeOwnerExpired(registry)).toBe(false)
    expect(SynergyLinkOwnerRegistry.activeOwnerExpired(registry, Date.now() + 2000)).toBe(true)

    const expired = SynergyLinkOwnerRegistry.hydrate({
      local: { activeOwnerID: "synergy:me", ownerIDs: ["synergy:me"], leaseExpiresAt: 1 },
    })
    expect(SynergyLinkOwnerRegistry.hasActiveLocalOwner(expired)).toBe(false)
    expect(SynergyLinkOwnerRegistry.activeOwnerExpired(expired)).toBe(true)
  })

  test("loadFile and saveFile round-trip owner state", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "synergy-link-owner-registry-"))
    tempRoots.push(root)
    process.env.SYNERGY_LINK_HOME = root

    expect((await SynergyLinkOwnerRegistry.loadFile()).local.ownerIDs).toEqual([])

    const registry = SynergyLinkOwnerRegistry.defaultRegistry()
    SynergyLinkOwnerRegistry.declareLocalOwner(registry, "synergy:me")
    await SynergyLinkOwnerRegistry.saveFile(registry)

    const loaded = await SynergyLinkOwnerRegistry.loadFile()
    expect(loaded.local.activeOwnerID).toBe("synergy:me")

    const raw = JSON.parse(await readFile(path.join(root, "owner.json"), "utf8"))
    expect(raw.local.activeOwnerID).toBe("synergy:me")
  })
})
