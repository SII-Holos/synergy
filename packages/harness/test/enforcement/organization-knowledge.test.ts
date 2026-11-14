import { expect, test } from "bun:test"
import { EnforcementGate } from "../../src/enforcement/gate"
import { ToolTaxonomy } from "../../src/tool/taxonomy"
import { testRuntime } from "../support/runtime"

test("organization knowledge remains a read-only service capability without a Workspace", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    const gate = await EnforcementGate.create({ activeWorkspace: null, workspaceType: "home", profileId: "guarded" })
    for (const operation of ["list", "files", "read", "search"])
      expect(gate.classify("organization_knowledge", { input: { operation } }).capabilities).toEqual([
        { class: "network_read", nonBypassable: false },
      ])
    expect(ToolTaxonomy.classify("organization_knowledge")).toEqual({
      kind: "knowledge.wiki",
      domain: "knowledge",
      traits: { externalIO: true },
    })
  })
})
