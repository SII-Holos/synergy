import assert from "node:assert/strict"
import { normalizeName, initials } from "/app/names.mjs"

const cases = [
  ["Ada Lovelace", "Ada Lovelace", "AL"],
  ["  Ada\t\n Lovelace  ", "Ada Lovelace", "AL"],
  ["a     b", "a b", "AB"],
  ["", "", ""],
  ["\t \u2003\n", "", ""],
  ["éclair\u00a0Ångström", "éclair Ångström", "ÉÅ"],
  ["𐐨𐐲 Smith", "𐐨𐐲 Smith", "𐐀S"],
  ["😀 Team", "😀 Team", "😀T"],
  ["中文\u2003名字", "中文 名字", "中名"],
]
for (const [input, normalized, expected] of cases) {
  assert.equal(normalizeName(input), normalized)
  assert.equal(initials(input), expected)
}
console.log(`${cases.length} name cases passed`)
