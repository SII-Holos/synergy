import { expect, test } from "bun:test"
import { attachmentRowBoundary } from "../../src/components/attachment-row-model"

test("two-row folding uses rendered row positions without changing attachment order", () => {
  expect(
    attachmentRowBoundary([
      { top: 0, bottom: 64 },
      { top: 0, bottom: 38 },
      { top: 72, bottom: 160 },
      { top: 72, bottom: 110 },
      { top: 168, bottom: 206 },
    ]),
  ).toEqual({ visible: 4, height: 160 })
  expect(attachmentRowBoundary([{ top: 0, bottom: 38 }])).toEqual({ visible: 1, height: undefined })
})
