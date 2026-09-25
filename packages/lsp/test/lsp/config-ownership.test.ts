import { expect, test } from "bun:test"
import { z } from "zod"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { ConfigExtensions } from "@ericsanchezok/synergy-harness/config/extensions"
import { createLocalHost } from "@ericsanchezok/synergy-local-runtime"
import { registerConfig } from "../../src/config-schema"

test("LSP configuration registers without installing MCP, formatters or external agents", () => {
  const runtime = RuntimeContext.create(createLocalHost())
  try {
    runtime.run(() => {
      registerConfig()
      ConfigExtensions.completeRegistration()
      expect(Object.keys(ConfigExtensions.schema(z.object({})).shape).sort()).toEqual([
        "lsp",
        "lspDiagnostics",
        "lspWriteDiagnostics",
        "toolExposure",
      ])
    })
  } finally {
    runtime.dispose()
  }
})
