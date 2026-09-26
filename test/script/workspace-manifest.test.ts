import { expect, test } from "bun:test"
import path from "node:path"
import { workspaces, workspaceGraph } from "../../script/workspace-manifest"

test("the core install graph includes plugin execution without HTTP or the authoring toolchain", () => {
  const packages = workspaces(path.resolve(import.meta.dirname, "../.."))
  const graph = workspaceGraph(packages, { optionalPeers: false })
  const selected = new Set<string>()
  function include(name: string) {
    if (selected.has(name)) return
    selected.add(name)
    for (const dependency of graph[name] ?? []) include(dependency)
  }
  include("@ericsanchezok/synergy-cli")
  expect(selected.has("@ericsanchezok/synergy-agent-runtime")).toBe(true)
  expect(selected.has("@ericsanchezok/synergy-plugin-host")).toBe(true)
  for (const name of ["server", "plugin-kit", "library", "mcp", "browser-runtime"])
    expect(selected.has(`@ericsanchezok/synergy-${name}`)).toBe(false)
  include("@ericsanchezok/synergy-presets")
  expect(selected.has("@ericsanchezok/synergy-server")).toBe(true)
  expect(selected.has("@ericsanchezok/synergy-plugin-kit")).toBe(true)
})
