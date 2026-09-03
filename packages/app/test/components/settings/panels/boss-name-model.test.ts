import { describe, expect, test } from "bun:test"
import type { MemoryInfo } from "@ericsanchezok/synergy-sdk/client"
import {
  BOSS_NAME_MEMORY_TITLE,
  bossNameFromRows,
  saveBossName,
  type BossNameGateway,
} from "../../../../src/components/settings/panels/boss-name-model"

function memoryRow(overrides: Partial<MemoryInfo>): MemoryInfo {
  return {
    id: "mem_1",
    title: "other",
    content: "other content",
    category: "self",
    recallMode: "search_only",
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  }
}

function gatewayStub(rows: MemoryInfo[]) {
  const calls: Array<{ kind: "create" | "update"; input: Record<string, unknown> }> = []
  const gateway: BossNameGateway = {
    listSelfMemories: async () => [...rows],
    createMemory: async (input) => {
      calls.push({ kind: "create", input: { ...input } })
      rows.push(memoryRow({ id: `mem_${rows.length + 1}`, ...input }))
    },
    updateMemory: async (input) => {
      calls.push({ kind: "update", input: { ...input } })
      const row = rows.find((candidate) => candidate.id === input.id)
      if (row) Object.assign(row, input)
    },
  }
  return { gateway, calls }
}

describe("boss name memory model", () => {
  test("extracts the boss_name row content trimmed from a self memory list", () => {
    expect(
      bossNameFromRows([
        memoryRow({ title: "other", content: "ignored" }),
        memoryRow({ id: "mem_2", title: BOSS_NAME_MEMORY_TITLE, content: "  Xiaofei  " }),
      ]),
    ).toBe("Xiaofei")
    expect(bossNameFromRows([memoryRow({ title: "other", content: "ignored" })])).toBe("")
    expect(bossNameFromRows([])).toBe("")
  })

  test("skips the library write when the draft name is empty or whitespace", async () => {
    const { gateway, calls } = gatewayStub([])
    expect(await saveBossName(gateway, "   ")).toBe("skipped")
    expect(calls).toEqual([])
  })

  test("creates the boss_name self memory row when none exists", async () => {
    const { gateway, calls } = gatewayStub([])
    expect(await saveBossName(gateway, "  Xiaofei ")).toBe("created")
    expect(calls).toEqual([
      {
        kind: "create",
        input: {
          title: BOSS_NAME_MEMORY_TITLE,
          content: "Xiaofei",
          category: "self",
          recallMode: "search_only",
        },
      },
    ])
  })

  test("updates the existing boss_name row in place instead of duplicating", async () => {
    const existing = memoryRow({ title: BOSS_NAME_MEMORY_TITLE, content: "Old" })
    const { gateway, calls } = gatewayStub([existing])
    expect(await saveBossName(gateway, "New Name")).toBe("updated")
    expect(calls).toEqual([
      {
        kind: "update",
        input: {
          id: "mem_1",
          title: BOSS_NAME_MEMORY_TITLE,
          content: "New Name",
          category: "self",
          recallMode: "search_only",
        },
      },
    ])
    expect(existing.content).toBe("New Name")
  })

  test("ignores unrelated self rows when looking for the boss name row", async () => {
    const other = memoryRow({ title: "other", content: "irrelevant" })
    const { gateway, calls } = gatewayStub([other])
    expect(await saveBossName(gateway, "Xiaofei")).toBe("created")
    expect(calls[0]?.kind).toBe("create")
  })
})
