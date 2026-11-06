import { expect, test } from "bun:test"
import { FeatureSelection, type FeatureDefinition } from "@ericsanchezok/synergy-util/features"
import { Features } from "../../src/lifecycle/features"
import { RuntimeContext } from "../../src/lifecycle/context"
import { runtimeHome } from "../support/runtime-home"

const definitions: FeatureDefinition[] = ["live", "restart"].map((activation) => ({
  id: activation,
  owner: "host",
  maturity: "experimental",
  activation: activation as "live" | "restart",
  name: activation,
  description: "Fixture behavior",
}))
const plan = (optIn: string[] = []) =>
  FeatureSelection.resolve([{ id: "host", version: "1.0.0", features: { kind: "product", definitions } }], { optIn })

test("restart preferences remain pending while live choices change only subsequent operations", async () => {
  await using home = await runtimeHome()
  const runtime = RuntimeContext.create(home.host)
  try {
    await runtime.run(async () => {
      Features.register(plan())
      let release!: () => void
      const pause = new Promise<void>((resolve) => {
        release = resolve
      })
      const operation = async () => {
        const enabled = Features.enabled("live")
        await pause
        return enabled ? "new" : "current"
      }
      const current = operation()
      Features.reload(["live", "restart"])
      release()
      expect(await current).toBe("current")
      expect(await operation()).toBe("new")
      expect(Features.enabled("restart")).toBe(false)
      expect(Features.catalog().find((x) => x.id === "restart")?.pendingRestart).toBe(true)
      Features.reload([])
      expect(Features.catalog().some((x) => x.pendingRestart)).toBe(false)
    })
  } finally {
    runtime.dispose()
  }
})

test("runtime instances are isolated and a new startup applies restart choices", async () => {
  await using firstHome = await runtimeHome()
  await using secondHome = await runtimeHome()
  const first = RuntimeContext.create(firstHome.host)
  const second = RuntimeContext.create(secondHome.host)
  try {
    first.run(() => Features.register(plan()))
    second.run(() => Features.register(plan(["restart"])))
    first.run(() => {
      expect(Features.enabled("restart")).toBe(false)
      Features.reload(["live", "missing"])
      expect(Features.catalog().find((x) => x.id === "missing")?.reason).toBe("not-installed")
    })
    second.run(() => {
      expect(Features.enabled("restart")).toBe(true)
      expect(Features.enabled("live")).toBe(false)
    })
  } finally {
    first.dispose()
    second.dispose()
  }
})
