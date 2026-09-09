import { expect, test } from "bun:test"
import { parseCoverageArguments } from "../../script/coverage-check"

test("coverage arguments recognize help and reject mistakes before any test command", () => {
  expect(parseCoverageArguments(["--help"]).help).toBe(true)
  expect(
    parseCoverageArguments(["--existing", "--json", "--package", "packages/cli", "--package", "packages/server"]),
  ).toEqual({
    help: false,
    existing: true,
    json: true,
    validateOnly: false,
    packages: ["packages/cli", "packages/server"],
  })
  expect(() => parseCoverageArguments(["--packge", "packages/cli"])).toThrow()
  expect(() => parseCoverageArguments(["--package"])).toThrow()
  expect(() => parseCoverageArguments(["unexpected"])).toThrow()
})
