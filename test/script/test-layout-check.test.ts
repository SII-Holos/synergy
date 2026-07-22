import { describe, expect, test } from "bun:test"
import { findMisplacedTestFiles } from "../../script/test-layout-check"

const packageRoots = ["packages/app", "packages/sdk/js", "packages/ui"]

describe("test layout check", () => {
  test("accepts tests in the owning package test directory", () => {
    expect(
      findMisplacedTestFiles(
        [
          "test/script/root.test.ts",
          "packages/app/test/components/button.test.tsx",
          "packages/meta-synergy/test/migration.test.ts",
          "packages/sdk/js/test/client.test.ts",
          "packages/ui/test/components/card.spec.tsx",
          "packages/app/src/components/button.tsx",
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
          "packages/app/src/components/button.test.tsx",
          "packages/app/script/i18n.test.ts",
          "packages/sdk/js/src/client.spec.ts",
        ],
        packageRoots,
      ),
    ).toEqual([
      "packages/app/script/i18n.test.ts",
      "packages/app/src/components/button.test.tsx",
      "packages/sdk/js/src/client.spec.ts",
      "script/release.test.ts",
    ])
  })

  test("does not classify non-test source filenames as tests", () => {
    expect(
      findMisplacedTestFiles(
        ["packages/app/src/testing/helpers.ts", "packages/ui/src/components/test-card.tsx", "script/test-runner.ts"],
        packageRoots,
      ),
    ).toEqual([])
  })
})
