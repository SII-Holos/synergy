import { expect, test } from "bun:test"
import { testPolicy } from "../../script/test-policy-check"

test("policy recognizes Bun bindings and ignores comments, strings and unrelated methods", () => {
  expect(
    testPolicy("fixture.ts", 'import { test as scenario } from "bun:test"; scenario.only("x", () => {})', false, "")
      .errors,
  ).toHaveLength(1)
  expect(
    testPolicy("fixture.ts", 'const text = "test.only"; object.only(); // mock.module("x")', false, "").errors,
  ).toEqual([])
})

test("new global module replacements require registered process isolation", () => {
  const source = 'import { mock } from "bun:test"; mock.module("fs", () => ({}))'
  expect(testPolicy("fixture.ts", source, false, "").errors).toHaveLength(1)
  expect(testPolicy("fixture.ts", source, true, "").errors).toEqual([])
  expect(testPolicy("fixture.ts", source, false, source).errors).toEqual([])
  expect(testPolicy("fixture.ts", source, false, source).warnings).toHaveLength(1)
})

test("retry and fixed sleeps are visible without treating timing experiments as forbidden", () => {
  const source = 'import { test } from "bun:test"; test("x", async () => { await Bun.sleep(100) }, { retry: 3 })'
  const result = testPolicy("fixture.ts", source, false, "")
  expect(result.errors).toHaveLength(1)
  expect(result.warnings).toHaveLength(1)
})
