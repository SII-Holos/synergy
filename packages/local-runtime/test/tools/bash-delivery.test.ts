import { expect, test } from "bun:test"
import { AttachmentDelivery } from "@ericsanchezok/synergy-harness/attachment/delivery"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Environment } from "@ericsanchezok/synergy-harness/environment"
import { BashTool } from "../../src/tools/bash"
import { testRuntime } from "../support/runtime"

test("bash exposes only the selected host delivery instructions without allocating an Environment", async () => {
  for (const custom of [true, false]) {
    await using runtime = await testRuntime({
      register: custom
        ? () => AttachmentDelivery.register({ response: "Use the host receipt.", execution: "Deliver using $&host." })
        : undefined,
    })
    await runtime.run(() =>
      ScopeContext.provide({
        scope: Scope.home(),
        workspace: null,
        async fn() {
          const tool = await BashTool.init()
          if (custom) {
            expect(tool.description).toContain("Deliver using $&host.")
            expect(tool.description).not.toContain("captured as immutable attachments")
          } else {
            expect(tool.description).toContain("captured as immutable attachments")
            expect(tool.description).not.toContain("Deliver using $&host.")
          }
          expect(tool.description).not.toContain("${artifactGuidance}")
          expect((await Environment.list("home")).every((item) => !item.allocation)).toBeTrue()
        },
      }),
    )
  }
})
