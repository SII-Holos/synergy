import { describe, expect, test } from "bun:test"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
  __testHooks,
  buildGraph,
  extractImports,
  layerOf,
  r3Violations,
  resolveSpec,
  stronglyConnectedComponents,
  summarize,
} from "../../script/dep-analyze"

describe("extractImports", () => {
  test("collects value imports, side-effect imports, and dynamic imports", () => {
    const source = [
      'import { Log } from "@/util/log"',
      'import type { Info } from "./types"',
      'import "./side-effect"',
      'const mod = await import("../lazy/module")',
      'import TEXT from "./prompt/plan.txt"',
      "",
    ].join("\n")
    const result = extractImports(source)
    expect([...result.specs].sort()).toEqual(["../lazy/module", "./side-effect", "./types", "@/util/log"])
    expect(result.typeOnly.has("./types")).toBe(true)
    expect(result.typeOnly.has("@/util/log")).toBe(false)
  })

  test("records re-exports", () => {
    const result = extractImports('export { helper } from "./helper"')
    expect(result.specs.has("./helper")).toBe(true)
  })
})

describe("resolveSpec", () => {
  test("maps the @/ alias onto the source root", () => {
    expect(resolveSpec("/src/session/a.ts", "@/bus", "/src")).toBe("/src/bus")
  })

  test("resolves relative specifiers against the importing file", () => {
    expect(resolveSpec("/src/session/a.ts", "../lattice/policy", "/src")).toBe("/src/lattice/policy")
  })

  test("returns null for external packages", () => {
    expect(resolveSpec("/src/a.ts", "zod", "/src")).toBeNull()
  })
})

describe("stronglyConnectedComponents", () => {
  test("returns the mutually reachable set for a cycle", () => {
    const components = stronglyConnectedComponents({ a: ["b"], b: ["c"], c: ["a"], d: [] })
    expect(components).toHaveLength(1)
    expect(components[0]).toEqual(["a", "b", "c"])
  })

  test("returns nothing for an acyclic graph", () => {
    expect(stronglyConnectedComponents({ a: ["b"], b: [] })).toEqual([])
  })
})

describe("r3Violations", () => {
  test("flags product pairs outside the allowlist and permits listed ones", () => {
    const edges: Record<string, string[]> = {
      lattice: ["blueprint"],
      blueprint: ["plugin"],
      cortex: ["plugin"],
    }
    const violations = r3Violations(edges, { allowlist: [["lattice", "blueprint"]] })
    expect(violations).toEqual([
      ["blueprint", "plugin"],
      ["cortex", "plugin"],
    ])
  })

  test("ignores non-product endpoints", () => {
    expect(r3Violations({ session: ["blueprint"] }, { allowlist: [] })).toEqual([])
  })
})

describe("layerOf", () => {
  test("classifies the four layers plus unclassified roots", () => {
    expect(layerOf("session")).toBe("L1")
    expect(layerOf("lattice")).toBe("product")
    expect(layerOf("server")).toBe("L4")
    expect(layerOf("util")).toBe("L0")
    expect(layerOf("index.ts")).toBe("unclassified")
  })
})

describe("buildGraph + summarize", () => {
  const root = __testHooks.mkdtemp()
  const write = (relative: string, content: string) => {
    const target = join(root, relative)
    mkdirSync(join(target, ".."), { recursive: true })
    writeFileSync(target, content)
  }

  write("session/kernel.ts", 'import { Policy } from "../lattice/policy"\nexport const k = 1\n')
  write("lattice/policy.ts", 'import { Session } from "../session"\nexport const Policy = 1\n')
  write("tool/registry.ts", 'import { Boss } from "../boss/tools/assign"\nexport const r = 1\n')
  write("boss/tools/assign.ts", "export const Boss = 1\n")
  write("util/log.ts", 'import { Config } from "../config/config"\nexport const l = 1\n')
  write("main.ts", 'import { k } from "./session/kernel"\n')

  const graph = buildGraph(root)
  const summary = summarize(graph)

  test("aggregates module-level edges", () => {
    expect(graph.edges.session).toContain("lattice")
    expect(graph.edges.lattice).toContain("session")
    expect(graph.edges.tool).toContain("boss")
    expect(graph.edges.util).toContain("config")
    expect(graph.edges["main.ts"]).toEqual(["session"])
  })

  test("counts the core→product inversions that R1 gates", () => {
    expect(summary.l1ToProduct).toEqual([
      ["session", "lattice"],
      ["tool", "boss"],
    ])
  })

  test("detects the lattice↔session cycle", () => {
    expect(summary.cyclicSCCs).toHaveLength(1)
    expect(summary.cyclicSCCs[0]).toEqual(["lattice", "session"])
  })

  test("R3 violations default to an empty allowlist (all product pairs flagged)", () => {
    expect(summary.r3Violations).toEqual([])
  })

  rmSync(root, { recursive: true, force: true })
})
