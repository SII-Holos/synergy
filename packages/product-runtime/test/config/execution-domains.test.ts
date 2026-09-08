import "../../src/configuration"
import { expect, test } from "bun:test"
import path from "node:path"
import { migrateExecutionConfigFile } from "@ericsanchezok/synergy-harness/test/internal/config/migration"
import { Config } from "@ericsanchezok/synergy-harness/config/config"
import { ConfigLspCatalog } from "@ericsanchezok/synergy-harness/config/lsp-catalog"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"

test("domain migration preserves legacy timeout priority and moves prompts without losing sibling values", async () => {
  await using tmp = await tmpdir()
  const file = path.join(tmp.path, "120-runtime.jsonc")
  await Bun.write(
    path.join(tmp.path, "40-mcp.jsonc"),
    JSON.stringify({ mcpDefaults: { callTimeout: 10, connectTimeout: 20 } }),
  )
  await Bun.write(path.join(tmp.path, "60-agents.jsonc"), JSON.stringify({ default_agent: "synergy" }))
  await Bun.write(
    file,
    JSON.stringify({ experimental: { mcp_timeout: 99, coauthor_reminder: false, boss_mode: true, batch_tool: true } }),
  )
  expect(await migrateExecutionConfigFile(file)).toBe(true)
  expect(await Bun.file(file).json()).toEqual({ boss: { enabled: true } })
  expect(await Bun.file(path.join(tmp.path, "40-mcp.jsonc")).json()).toEqual({
    mcpDefaults: { callTimeout: 99, connectTimeout: 20 },
  })
  expect(await Bun.file(path.join(tmp.path, "60-agents.jsonc")).json()).toEqual({
    default_agent: "synergy",
    prompt: { coauthorReminder: false },
  })
  expect(await migrateExecutionConfigFile(file)).toBe(false)
})

test("built-in LSP enablement accepts partial configuration while custom servers need commands", () => {
  ConfigLspCatalog.registerServerIds(["ty", "pyright"])
  expect(Config.Info.safeParse({ lsp: { ty: { disabled: false }, pyright: { disabled: true } } }).success).toBe(true)
  expect(Config.Info.safeParse({ lsp: { unknown: { disabled: false } } }).success).toBe(false)
  expect(Config.Info.safeParse({ lsp: { ty: { env: { TEST: "1" } } } }).success).toBe(false)
})
