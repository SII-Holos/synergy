import { describe, expect, test } from "bun:test"
import { findMisplacedTestFiles } from "../../script/test-layout-check"

const packageRoots = ["apps/web", "packages/sdk/js", "packages/ui"]

describe("test layout check", () => {
  test("accepts tests in the owning package test directory", () => {
    expect(
      findMisplacedTestFiles(
        [
          "test/script/root.test.ts",
          "apps/web/test/components/button.test.tsx",
          "packages/sdk/js/test/client.test.ts",
          "packages/ui/test/components/card.spec.tsx",
          "apps/web/src/components/button.tsx",
        ],
        packageRoots,
      ),
    ).toEqual([])
  })

  test("rejects tests colocated with source and script files", () => {
    expect(
      findMisplacedTestFiles(
        [
          "script/release.test.ts",
          "apps/web/src/components/button.test.tsx",
          "apps/web/script/i18n.test.ts",
          "packages/sdk/js/src/client.spec.ts",
        ],
        packageRoots,
      ),
    ).toEqual([
      "apps/web/script/i18n.test.ts",
      "apps/web/src/components/button.test.tsx",
      "packages/sdk/js/src/client.spec.ts",
      "script/release.test.ts",
    ])
  })

  test("does not classify non-test source filenames as tests", () => {
    expect(
      findMisplacedTestFiles(
        ["apps/web/src/testing/helpers.ts", "packages/ui/src/components/test-card.tsx", "script/test-runner.ts"],
        packageRoots,
      ),
    ).toEqual([])
  })
})
