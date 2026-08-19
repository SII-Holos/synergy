import { describe, expect, test } from "bun:test"
import { detectCycles, runGateSet, validateGateGraph, type Gate } from "../../script/gates"

function gate(id: string, needs: string[] = []): Gate {
  return { id, run: `echo ${id}`, needs }
}

async function noop(_gate: Gate) {
  return null
}

describe("gate graph validation", () => {
  test("detects cycles", () => {
    expect(detectCycles([gate("a", ["b"]), gate("b", ["a"])])).toHaveLength(1)
  })

  test("accepts acyclic graphs", () => {
    expect(detectCycles([gate("a", ["b"]), gate("b", [])])).toEqual([])
  })

  test("flags unknown dependencies and duplicates", () => {
    const errors = validateGateGraph([gate("a", ["ghost"]), gate("a"), gate("b")])
    expect(errors.some((error) => error.includes("unknown dependency: ghost"))).toBe(true)
    expect(errors.some((error) => error.includes("duplicate gate id: a"))).toBe(true)
  })
})

describe("gate scheduling", () => {
  test("runs every gate exactly once in dependency order", async () => {
    const order: string[] = []
    const gates: Gate[] = [gate("a"), gate("b", ["a"]), gate("c", ["a"])]
    const result = await runGateSet(gates, "/tmp", async (current) => {
      await Bun.sleep(5)
      order.push(current.id)
      return null
    })
    expect(result.failures).toEqual([])
    expect(order).toHaveLength(3)
    expect(order.indexOf("b")).toBeGreaterThan(order.indexOf("a"))
    expect(order.indexOf("c")).toBeGreaterThan(order.indexOf("a"))
  })

  test("collects failures without stopping other gates", async () => {
    const gates: Gate[] = [gate("a"), gate("b"), gate("c")]
    const result = await runGateSet(gates, "/tmp", async (current) => {
      if (current.id === "b") return { gate: "b", exitCode: 1, stderr: "boom" }
      return null
    })
    expect(result.failures).toEqual([{ gate: "b", exitCode: 1, stderr: "boom" }])
    expect(result.gates.sort()).toEqual(["a", "b", "c"])
  })

  test("rejects invalid graphs before scheduling", async () => {
    await expect(runGateSet([gate("a", ["a"])], "/tmp", noop)).rejects.toThrow("cycle")
  })
})
