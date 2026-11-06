import { describe, expect, test } from "bun:test"
import path from "node:path"
import { Info } from "../../src/config/schema"
import { Config } from "../../src/config/config"
import { ScopeContext } from "../../src/scope/context"
import { tmpdir } from "../support/fixture"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()

const MIB = 1024 * 1024
const GIB = 1024 * MIB

describe("attachment upload limits", () => {
  test("rejects non-positive sizes, non-positive counts, and unknown keys", () =>
    runtime.run(() => {
      expect(Info.safeParse({ attachment: { maxFileBytes: 0 } }).success).toBe(false)
      expect(Info.safeParse({ attachment: { maxTotalBytes: -1 } }).success).toBe(false)
      expect(Info.safeParse({ attachment: { maxFiles: 0 } }).success).toBe(false)
      expect(Info.safeParse({ attachment: { bogus: true } }).success).toBe(false)
    }))

  test("materializes defaults: 200 MiB per file, 2 GiB total, 20 files", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const config = await Config.current()
          expect(config.attachment?.maxFileBytes).toBe(200 * MIB)
          expect(config.attachment?.maxTotalBytes).toBe(2 * GIB)
          expect(config.attachment?.maxFiles).toBe(20)
        },
      })
    }))

  test("user-set values survive default materialization", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          await Bun.write(
            path.join(dir, ".synergy/synergy.d/00-general.jsonc"),
            JSON.stringify({ attachment: { maxFileBytes: 512 * MIB } }),
          )
        },
      })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const config = await Config.current()
          expect(config.attachment?.maxFileBytes).toBe(512 * MIB)
          expect(config.attachment?.maxTotalBytes).toBe(2 * GIB)
          expect(config.attachment?.maxFiles).toBe(20)
        },
      })
    }))

  test("attachment key belongs to the general config domain", () =>
    runtime.run(async () => {
      const { ConfigDomain } = await import("../../src/config/domain")
      expect(ConfigDomain.byKey().get("attachment")?.id).toBe("general")
    }))
})

afterRuntimeTests(() => runtime.close())
