import { afterEach, expect, mock, test } from "bun:test"
import path from "path"
import { data } from "../../src/provider/models-macro"

const originalFetch = globalThis.fetch
const originalModelsPath = process.env.MODELS_DEV_API_JSON

afterEach(() => {
  globalThis.fetch = originalFetch
  if (originalModelsPath === undefined) {
    delete process.env.MODELS_DEV_API_JSON
  } else {
    process.env.MODELS_DEV_API_JSON = originalModelsPath
  }
})

test("falls back to the default cache when remote fetch fails", async () => {
  delete process.env.MODELS_DEV_API_JSON
  globalThis.fetch = mock(async () => {
    throw new Error("offline")
  }) as unknown as typeof fetch

  const expectedPath = path.join(process.env.SYNERGY_TEST_HOME!, ".synergy", "cache", "models.json")
  const expected = await Bun.file(expectedPath).text()

  await expect(data()).resolves.toEqual(expected)
})
