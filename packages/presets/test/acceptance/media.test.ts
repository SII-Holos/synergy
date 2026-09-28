import { expect, test } from "bun:test"
import { chromium } from "playwright-core"
import { mediaFixtures } from "../../script/acceptance/media-fixtures"
import path from "node:path"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { media } from "../../script/acceptance/media"
import { selectCases } from "../../script/acceptance/catalog"
import { makePlan } from "../../script/acceptance/runner"
import { fixtureProvider, fixtureSettings } from "./support"

test("attachment recognition cannot read an on-disk answer key or use shell access to excluded content", async () => {
  await using tmp = await tmpdir()
  const directory = path.join(tmp.path, "attempt")
  const observed: Array<{ answerKeyVisible: boolean; tools: unknown }> = []
  using provider = fixtureProvider(async (input) => {
    observed.push({
      answerKeyVisible: await Bun.file(path.join(directory, "fixtures.json")).exists(),
      tools: input.tools ?? [],
    })
    return "No identifiers were recognized by this deterministic fixture"
  })
  const settings = {
    ...(await fixtureSettings(tmp.path, provider.url.toString())),
    chromium: chromium.executablePath(),
  }
  const cases = selectCases("attachment-policy")
  const plan = await makePlan({ source: "a".repeat(40), directory: path.join(tmp.path, "plan"), cases, inputs: [] })
  await media(settings)({ plan, scenario: cases[0]!, directory, attempt: 1 })
  expect(observed.length).toBeGreaterThan(0)
  expect(observed.every((request) => !request.answerKeyVisible)).toBe(true)
  expect(observed.every((request) => Array.isArray(request.tools) && request.tools.length === 0)).toBe(true)
}, 60_000)

test("media fixtures contain independent random document and raster content with preserved original bytes", async () => {
  const files = await mediaFixtures(chromium.executablePath())
  expect(new Set(files.map((file) => file.marker)).size).toBe(files.length)
  expect(files.map((file) => file.filename)).toEqual([
    "visual.png",
    "visual.jpg",
    "record.pdf",
    "record.docx",
    "record.xlsx",
    "record.pptx",
    "record.txt",
  ])
  for (const file of files) {
    expect(file.bytes.length).toBeGreaterThan(20)
    expect(file.filename).not.toContain(file.marker)
  }
  expect(files[0]!.bytes.subarray(1, 4).toString()).toBe("PNG")
  expect(files[1]!.bytes.subarray(0, 2).toString("hex")).toBe("ffd8")
  expect(files[2]!.bytes.subarray(0, 4).toString()).toBe("%PDF")
}, 30_000)
