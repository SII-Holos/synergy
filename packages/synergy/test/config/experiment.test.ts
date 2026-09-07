import { expect, test } from "bun:test"
import { Experiment } from "../../src/config/experiment"
import { Config } from "../../src/config/config"

test("concurrent task policies remain immutable while security and process resources stay live", async () => {
  const base: Config.Info = {
    compaction: { auto: true },
    permission: { bash: "allow" },
    execution: { agentWorkers: 2 },
    cortex: { primaryOnlyTools: ["a", "b"] },
  }
  const file = Experiment.File.parse({
    version: 1,
    label: "no prune",
    overrides: { compaction: { prune: false }, cortex: { primaryOnlyTools: [] } },
  })
  const first = Experiment.capture(base, file)
  const second = Experiment.capture(base)
  const reloaded: Config.Info = {
    ...base,
    compaction: { auto: false, prune: true },
    permission: { bash: "deny" },
    execution: { agentWorkers: 4 },
  }
  await Promise.all(
    [first, second].map((snapshot) =>
      Experiment.provide(snapshot, async () => {
        await Bun.sleep(1)
        const current = Experiment.apply(reloaded)
        expect(current.compaction?.auto).toBe(true)
        expect(current.permission).toEqual({ bash: "deny" })
        expect(current.execution?.agentWorkers).toBe(4)
        expect(current.cortex?.primaryOnlyTools).toEqual(snapshot === first ? [] : ["a", "b"])
        expect(() => {
          Experiment.current()!.effective.compaction!.auto = false
        }).toThrow()
      }),
    ),
  )
  expect(Experiment.current()).toBeUndefined()
})

test("task settings cannot pretend to configure shared workers or permission grants", () => {
  for (const overrides of [{ execution: { agentWorkers: 5 } }, { permission: { bash: "allow" } }, { unexpected: true }])
    expect(Experiment.File.safeParse({ version: 1, label: "invalid", overrides }).success).toBe(false)
  expect(Experiment.File.safeParse({ version: 2, label: "unsupported" }).success).toBe(false)
})

test("explicit model overrides win and fingerprints are stable across capture time and key order", () => {
  const file = Experiment.File.parse({ version: 1, label: "one", overrides: { model: "test/experiment" } })
  const snapshot = Experiment.capture({ model: "test/default" }, file, { model: "test/command" })
  expect(snapshot.effective.model).toBe("test/command")
  expect(snapshot.sources.model).toBe("explicit_command")
  expect(Experiment.capture({ model: "test/default" }, file, { model: "test/command" }).fingerprint).toBe(
    snapshot.fingerprint,
  )
  expect(Experiment.fingerprint({ a: 1, b: 2 })).toBe(Experiment.fingerprint({ b: 2, a: 1 }))
})

test("attach checks process settings and one-shot runtime overrides reach configuration readers", () => {
  try {
    Experiment.configureRuntime({ execution: { agentWorkers: 3 }, formatter: false }, { formatter: false })
    expect(() => Experiment.assertRuntime({ execution: { agentWorkers: 3 } })).not.toThrow()
    expect(() => Experiment.assertRuntime({ execution: { agentWorkers: 5 } })).toThrow("differ")
    expect(Experiment.apply({ formatter: {} }).formatter).toBe(false)
  } finally {
    Experiment.configureRuntime()
  }
})
