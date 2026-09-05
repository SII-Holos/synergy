import { describe, expect, test } from "bun:test"
import type { MemoryInfo } from "@ericsanchezok/synergy-sdk/client"
import {
  BOSS_NAME_MEMORY_TITLE,
  bossNameFromRows,
  createBossNamePersister,
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

type GatewayCall =
  | { kind: "create"; input: Record<string, unknown> }
  | { kind: "update"; input: Record<string, unknown> }
  | { kind: "remove"; id: string }

function gatewayStub(rows: MemoryInfo[]) {
  const calls: GatewayCall[] = []
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
    removeMemory: async (id) => {
      calls.push({ kind: "remove", id })
      const index = rows.findIndex((candidate) => candidate.id === id)
      if (index !== -1) rows.splice(index, 1)
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

  test("skips the library write when the draft is empty and no row exists", async () => {
    const { gateway, calls } = gatewayStub([])
    expect(await saveBossName(gateway, "   ")).toBe("skipped")
    expect(calls).toEqual([])
  })

  test("removes the stored boss_name row when the draft is cleared", async () => {
    const existing = memoryRow({ id: "mem_5", title: BOSS_NAME_MEMORY_TITLE, content: "Xiaofei" })
    const { gateway, calls } = gatewayStub([existing])
    expect(await saveBossName(gateway, "   ")).toBe("removed")
    expect(calls).toEqual([{ kind: "remove", id: "mem_5" }])
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

describe("boss name persister", () => {
  test("serializes concurrent persists so the same draft never duplicates rows", async () => {
    const rows: MemoryInfo[] = []
    const { gateway, calls } = gatewayStub(rows)

    const persister = createBossNamePersister(gateway)
    await persister.persist("Xiaofei")
    expect(calls).toEqual([{ kind: "create", input: expect.objectContaining({ content: "Xiaofei" }) }])

    // Blur + unmount can both flush the same edited draft; the second wait
    // must observe the first write and become a no-op.
    const first = persister.persist("Xiaofei Chen")
    const second = persister.persist("Xiaofei Chen")
    await Promise.all([first, second])

    const createCalls = calls.filter((call) => call.kind === "create")
    const updateCalls = calls.filter((call) => call.kind === "update")
    expect(createCalls).toHaveLength(1)
    expect(updateCalls).toHaveLength(1)
    expect(rows).toHaveLength(1)
    expect(rows[0].content).toBe("Xiaofei Chen")
    expect(persister.getLastSavedName()).toBe("Xiaofei Chen")
  })

  test("adopting a stored name makes an identical persist a no-op", async () => {
    const existing = memoryRow({ title: BOSS_NAME_MEMORY_TITLE, content: "Xiaofei" })
    const { gateway, calls } = gatewayStub([existing])

    const persister = createBossNamePersister(gateway)
    persister.adoptStoredName("Xiaofei")
    await persister.persist("Xiaofei")
    expect(calls).toEqual([])
  })

  test("clearing a persisted name removes the row once and updates saved state", async () => {
    const existing = memoryRow({ id: "mem_9", title: BOSS_NAME_MEMORY_TITLE, content: "Xiaofei" })
    const { gateway, calls } = gatewayStub([existing])

    const persister = createBossNamePersister(gateway)
    // Mount backfill adopts the stored name; the panel then clears the field.
    persister.adoptStoredName("Xiaofei")
    await persister.persist("")
    expect(calls).toEqual([{ kind: "remove", id: "mem_9" }])
    expect(persister.getLastSavedName()).toBe("")
  })
})
