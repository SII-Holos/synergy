import { expect, test } from "bun:test"
import { RuntimeComponents } from "@ericsanchezok/synergy-harness/lifecycle"
import { ResourceSources } from "@ericsanchezok/synergy-harness/observability/resource-sources"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { localRuntime } from "@ericsanchezok/synergy-local-runtime/component"
import { plugins } from "../src/component"

function open(selected: boolean) {
  return testRuntime({
    env: { SYNERGY_CONFIG_CONTENT: JSON.stringify({ pluginMarketplace: { enabled: false } }) },
    composition: RuntimeComponents.compose([
      localRuntime({ workers: false, environment: false }),
      ...(selected ? [plugins()] : []),
    ]),
  })
}

test("plugin resource discovery stays with the selected Runtime and closes independently", async () => {
  await using core = await open(false)
  const selected = await open(true)
  try {
    expect(await core.run(() => ResourceSources.read())).toEqual([])
    expect(await selected.run(() => ResourceSources.read())).toEqual([
      expect.objectContaining({ owner: "plugin", processCount: 0, measuredProcessCount: 0, completeness: "full" }),
    ])
  } finally {
    await selected.close()
  }
  expect(await core.run(() => ResourceSources.read())).toEqual([])
})
