import { expect, test } from "bun:test"
import { createPluginFormatter } from "../src/format"

test("public formatters follow the current locale without recreating the component", () => {
  let locale = "en-US"
  const format = createPluginFormatter(() => locale)
  expect(format.number(1234.5)).toBe("1,234.5")
  expect(format.relative(-1, "day")).toBe("yesterday")
  locale = "de-DE"
  expect(format.number(1234.5)).toBe("1.234,5")
  expect(format.relative(-1, "day")).toBe("gestern")
  locale = "en-US"
  expect(
    format.date(new Date("2026-09-07T00:00:00Z"), {
      timeZone: "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }),
  ).toBe("09/07/2026")
})

test("byte formatting handles zero, fractional units and invalid sizes", () => {
  const format = createPluginFormatter(() => "en-US")
  expect(format.bytes(0)).toBe("0 byte")
  expect(format.bytes(1500)).toBe("1.5 kB")
  for (const value of [-1, NaN, Infinity]) expect(() => format.bytes(value)).toThrow(RangeError)
})
