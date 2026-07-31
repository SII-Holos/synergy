import { mock } from "bun:test"
import path from "path"
import { pathToFileURL } from "url"

const catalogModule = pathToFileURL(path.resolve(import.meta.dir, "../../../src/provider/catalog.ts")).href
const modelsModule = pathToFileURL(path.resolve(import.meta.dir, "../../../src/provider/models")).href
const modelsModuleWithExtension = pathToFileURL(path.resolve(import.meta.dir, "../../../src/provider/models.ts")).href

mock.module(modelsModuleWithExtension, () => ({}))
mock.module(modelsModule, () => ({}))

const catalog = await import(catalogModule)
if (!catalog.ProviderCatalog) {
  process.stderr.write("ProviderCatalog was not defined\n")
  process.exit(1)
}

process.stdout.write("OK\n")
