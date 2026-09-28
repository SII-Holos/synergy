import { expect, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { prepareRuntime } from "../../script/acceptance/runtime"

test("an invalid frozen catalog cannot silently fall back to the controller's bundled catalog", async () => {
  await using tmp = await tmpdir()
  const catalog = path.join(tmp.path, "catalog.json")
  await Bun.write(catalog, "{}")
  await expect(
    prepareRuntime(
      tmp.path,
      {
        providerID: "fixture",
        modelID: "model",
        upstream: "https://example.test",
        apiKeyFile: "unused",
        modelCatalog: catalog,
        config: {},
        deadlineMs: 1000,
      },
      { url: "http://127.0.0.1:1/v1", token: "fixture" },
    ),
  ).rejects.toThrow("Frozen model catalog")
})
