import { mock } from "bun:test"

mock.module("../../../src/provider/models", () => ({}))
const catalog = await import("../../../src/provider/catalog")
if (!catalog.ProviderCatalog) throw new Error("ProviderCatalog was not defined")
process.stdout.write("OK\n")
