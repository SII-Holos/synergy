import { expect, test } from "bun:test"
import { getShell, listShells, registerShell, subscribeShells } from "../../../src/plugin/registries/shell-registry"

test("Shell registration is observable and disposal only removes the owning entry", () => {
  let updates = 0
  const unsubscribe = subscribeShells(() => updates++)
  const first = registerShell({
    id: "alpha:main",
    pluginId: "alpha",
    label: "Alpha",
    loader: async () => ({ default: () => null }),
  })
  const second = registerShell({
    id: "beta:main",
    pluginId: "beta",
    label: "Beta",
    loader: async () => ({ default: () => null }),
  })
  expect(listShells().map((entry) => entry.id)).toEqual(["alpha:main", "beta:main"])
  expect(getShell("alpha:main")?.pluginId).toBe("alpha")
  first()
  first()
  expect(getShell("alpha:main")).toBeUndefined()
  expect(getShell("beta:main")).toBeDefined()
  expect(updates).toBe(3)
  second()
  unsubscribe()
})
