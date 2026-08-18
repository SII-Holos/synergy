import { describe, expect, test } from "bun:test"
import { ISOLATED_COVERAGE_FILES, splitCoverageBatches } from "../../script/coverage-run"

describe("coverage batch splitting", () => {
  test("keeps every discovered file exactly once across batches", () => {
    const files = [
      "test/a.test.ts",
      "test/vector/embedding-standalone.test.ts",
      "test/server/nav-global-routes.test.ts",
      "test/b.test.ts",
      "test/tool/openai-image-gen.test.ts",
      "test/channel/svg-raster-standalone.test.ts",
    ]
    const { main, isolated } = splitCoverageBatches(files)
    expect([...main, ...isolated].toSorted()).toEqual([...files].toSorted())
  })

  test("moves isolated files out of the main batch in canonical order", () => {
    const { main, isolated } = splitCoverageBatches([
      "test/a.test.ts",
      "test/vector/embedding-standalone.test.ts",
      "test/server/nav-global-routes.test.ts",
    ])
    expect(main).toEqual(["test/a.test.ts"])
    expect(isolated).toEqual(["test/vector/embedding-standalone.test.ts", "test/server/nav-global-routes.test.ts"])
  })

  test("isolated set is pinned to the known load-sensitive files", () => {
    expect([...ISOLATED_COVERAGE_FILES].toSorted()).toEqual([
      "test/channel/svg-raster-standalone.test.ts",
      "test/config/import.test.ts",
      "test/holos/runtime.test.ts",
      "test/plugin/mcp-declarative-oauth.test.ts",
      "test/provider/catalog-stability.test.ts",
      "test/provider/proxy.test.ts",
      "test/server/nav-global-routes.test.ts",
      "test/server/plugin-official-install.test.ts",
      "test/server/plugin-registry-routes.test.ts",
      "test/session/retry.test.ts",
      "test/tool/arxiv-download.test.ts",
      "test/tool/openai-image-gen.test.ts",
      "test/vector/embedding-standalone.test.ts",
    ])
  })
})
