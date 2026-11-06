import { expect, test } from "bun:test"
import {
  createWorkbenchPanelRegistry,
  getWorkbenchPanel,
} from "../../../src/plugin/registries/workbench-panel-registry"

test("native panel callbacks keep their owner across activation, disposal and resource changes", () => {
  const a = createWorkbenchPanelRegistry(),
    b = createWorkbenchPanelRegistry()
  const entry = (owner: string) => ({
    id: "owned-fixture",
    label: owner,
    surface: "side" as const,
    cardinality: "multi" as const,
    createTab: () => ({ resourceId: owner }),
  })
  const removeA = a.register(entry("A")),
    removeB = b.register(entry("B"))
  const releaseA = a.activate(),
    releaseB = b.activate()
  releaseA()
  expect(getWorkbenchPanel("owned-fixture")?.createTab?.()).toEqual({ resourceId: "B" })
  expect(a.get("owned-fixture")?.createTab?.()).toEqual({ resourceId: "A" })
  expect(b.get("owned-fixture")?.createTab?.()).toEqual({ resourceId: "B" })
  releaseB()
  expect(getWorkbenchPanel("owned-fixture")).toBeUndefined()
  removeA()
  removeB()
})
