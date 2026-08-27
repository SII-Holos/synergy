import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import type { PluginGrantContract } from "@ericsanchezok/synergy-plugin/integrity"
import { Global } from "../../src/global"
import {
  readApprovals,
  removeApproval,
  saveApproval,
  type PluginApprovalRecord,
} from "../../src/plugin/consent/approval-store"

function record(pluginId: string): PluginApprovalRecord {
  return {
    schemaVersion: 2,
    pluginId,
    source: "local",
    grant: { capabilities: [] } as unknown as PluginGrantContract,
    grantHash: `hash-${pluginId}`,
    approvedAt: Date.now(),
    approvedBy: "user",
    trustTier: "declarative",
    approvedCapabilities: [],
  }
}

function storeFile() {
  return path.join(Global.Path.data, "plugin-approvals.json")
}

async function tempResidue() {
  const entries = await fs.readdir(Global.Path.data).catch(() => [] as string[])
  return entries.filter((name) => name.includes(".tmp"))
}

describe("approval store concurrent read-modify-write", () => {
  test("concurrent saveApproval and removeApproval keep every record without lost updates", async () => {
    const run = Math.random().toString(36).slice(2)
    const ids = Array.from({ length: 12 }, (_, index) => `approval-race-${run}-${index}`)
    const removedId = `approval-race-${run}-removed`

    await saveApproval(record(removedId))
    await Promise.all([...ids.map((id) => saveApproval(record(id))), removeApproval(removedId)])

    const final = await readApprovals()
    const present = new Set(final.map((item) => item.pluginId))
    for (const id of ids) expect(present.has(id)).toBe(true)
    expect(present.has(removedId)).toBe(false)

    JSON.parse(await Bun.file(storeFile()).text())
    expect(await tempResidue()).toEqual([])
  })
})
