import { test, expect } from "bun:test"
import path from "path"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/scope/instance"
import { Config } from "../../src/config/config"
import { Agent as AgentSvc } from "../../src/agent/agent"

test("agent color parsed from project config", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "synergy.json"),
        JSON.stringify({
          $schema: "file:///test/config.schema.json",
          agent: {
            build: { color: "#FFA500" },
          },
        }),
      )
    },
  })
  await Instance.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const cfg = await Config.get()
      expect(cfg.agent?.["build"]?.color).toBe("#FFA500")
    },
  })
})

test("Agent.get includes color from config", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "synergy.json"),
        JSON.stringify({
          $schema: "file:///test/config.schema.json",
          agent: {
            explore: { color: "#A855F7" },
          },
        }),
      )
    },
  })
  await Instance.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const explore = await AgentSvc.get("explore")
      expect(explore?.color).toBe("#A855F7")
    },
  })
})
