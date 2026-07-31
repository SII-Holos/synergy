import { afterEach, expect, mock, test } from "bun:test"
import path from "path"
import { pathToFileURL } from "url"

const catalogModule = pathToFileURL(path.resolve(import.meta.dir, "../../src/provider/catalog.ts")).href
const modelsModule = pathToFileURL(path.resolve(import.meta.dir, "../../src/provider/models")).href
const modelsModuleWithExtension = pathToFileURL(path.resolve(import.meta.dir, "../../src/provider/models.ts")).href

afterEach(() => {
  mock.restore()
})

test("ProviderCatalog module import does not crash when ModelsDev module export is missing", async () => {
  mock.module(modelsModuleWithExtension, () => {
    return {}
  })
  mock.module(modelsModule, () => {
    return {}
  })

  const catalog = await import(catalogModule)
  expect(catalog.ProviderCatalog).toBeDefined()
})
