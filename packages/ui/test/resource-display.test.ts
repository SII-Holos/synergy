import { expect, test } from "bun:test"
import { ResourceReference } from "@ericsanchezok/synergy-util/resource-reference"
import { resourceDisplay } from "../src/components/resource-display"

const github =
  "https://github.com/deepseek-ai/deepseek-harness/blob/86a402200d95fecef4529d969836f1fe13c6cb0d/packages/compaction/compaction-basic/src/index.ts#L289-L327"

test("resource display keeps the original GitHub sample compact unless its target needs context", () => {
  const reference = ResourceReference.parse(github)
  expect(resourceDisplay(reference)).toMatchObject({
    label: "deepseek-harness / index.ts:289–327",
    source: "github.com",
    icon: "github.main",
  })
  expect(resourceDisplay(reference).disambiguatedLabel).toBe(
    "deepseek-ai/deepseek-harness / blob/86a402200d95fecef4529d969836f1fe13c6cb0d/packages/compaction/compaction-basic/src/index.ts:289–327",
  )
  expect(resourceDisplay(reference, [reference, reference]).label).toBe("deepseek-harness / index.ts:289–327")
})

test.each([
  ["https://example.org/?doc=first", "example.org?doc=first"],
  ["https://example.org/?doc=second", "example.org?doc=second"],
  ["https://example.org/docs#first", "example.org/docs#first"],
  ["https://example.org/docs#second", "example.org/docs#second"],
  [
    "https://example.org/%E6%96%87%E6%A1%A3?q=%E4%B8%AD%E6%96%87%20text&path=a%2Fb%3Fc#%E7%AB%A0%E8%8A%82",
    "example.org/文档?q=中文 text&path=a%2Fb%3Fc#章节",
  ],
  ["https://example.org/a%2Fb?q=%23part#part%2Fone", "example.org/a%2Fb?q=%23part#part%2Fone"],
  ["https://example.org/a%252Fb?q=%2523part#part%252Fone", "example.org/a%252Fb?q=%2523part#part%252Fone"],
  ["https://example.org/a?bad=%E0%A4%A#part", "example.org/a?bad=%E0%A4%A#part"],
  ["https://example.org/?#", "example.org?#"],
])("resource display retains the readable full query and fragment of %s", (url, label) => {
  const reference = Object.freeze(ResourceReference.parse(url))
  expect(resourceDisplay(reference)).toMatchObject({ label, source: "example.org", icon: "browser.main" })
  expect(ResourceReference.format(reference)).toBe(url)
})

test("resource display never truncates or reorders distinguishing query values", () => {
  const value = "complete-value-".repeat(30)
  const url = `https://example.org/docs?doc=${value}&doc=second&empty=&flag#chapter`
  const reference = Object.freeze(ResourceReference.parse(url))
  expect(resourceDisplay(reference).label).toBe(`example.org/docs?doc=${value}&doc=second&empty=&flag#chapter`)
  expect(ResourceReference.format(reference)).toBe(url)
})

test.each([
  "https://github.example.org/org/repo/blob/main/index.ts?q=one#part",
  "https://github.com.example.org/org/repo/blob/main/index.ts?q=one#part",
  "https://github.com@hostile.example/org/repo/blob/main/index.ts?q=one#part",
])("resource display uses the exact parsed host and a neutral icon for %s", (value) => {
  const url = new URL(value)
  expect(resourceDisplay(ResourceReference.parse(value))).toMatchObject({
    label: `${url.host}${url.pathname}${url.search}${url.hash}`,
    source: url.hostname,
    icon: "browser.main",
  })
})

test.each([
  {
    name: "owner",
    urls: [
      "https://github.com/first/repo/blob/main/src/index.ts#L2",
      "https://github.com/second/repo/blob/main/src/index.ts#L2",
    ],
    labels: ["first/repo / index.ts:2", "second/repo / index.ts:2"],
  },
  {
    name: "path",
    urls: [
      "https://github.com/org/repo/blob/main/packages/first/index.ts#L2",
      "https://github.com/org/repo/blob/main/packages/second/index.ts#L2",
    ],
    labels: ["repo / first/index.ts:2", "repo / second/index.ts:2"],
  },
  {
    name: "commit, including commits with the same short prefix",
    urls: [
      "https://github.com/org/repo/blob/86a402200d95fecef4529d969836f1fe13c6cb0d/src/index.ts#L2",
      "https://github.com/org/repo/blob/86a402200d95fecef4529d969836f1fe13c6cb0e/src/index.ts#L2",
    ],
    labels: [
      "repo@86a402200d95fecef4529d969836f1fe13c6cb0d / index.ts:2",
      "repo@86a402200d95fecef4529d969836f1fe13c6cb0e / index.ts:2",
    ],
  },
  {
    name: "branch route without guessing a slash-containing ref boundary",
    urls: [
      "https://github.com/org/repo/blob/main/src/index.ts#L2",
      "https://github.com/org/repo/blob/feature/topic/src/index.ts#L2",
    ],
    labels: ["repo / blob/main/src/index.ts:2", "repo / blob/feature/topic/src/index.ts:2"],
  },
  {
    name: "encoded branch route",
    urls: [
      "https://github.com/org/repo/blob/feature%2Ffirst/src/index.ts#L2",
      "https://github.com/org/repo/blob/feature%2Fsecond/src/index.ts#L2",
    ],
    labels: ["repo / blob/feature%2Ffirst/src/index.ts:2", "repo / blob/feature%2Fsecond/src/index.ts:2"],
  },
])("resource display adds only useful $name context for collision peers", ({ urls, labels }) => {
  const peers = Object.freeze(urls.map((url) => Object.freeze(ResourceReference.parse(url))))
  expect(peers.map((reference) => resourceDisplay(reference, peers).label)).toEqual([...labels])
  expect(peers.map((reference) => resourceDisplay(reference, [...peers].reverse()).label)).toEqual([...labels])
  expect(peers.map((reference) => ResourceReference.format(reference))).toEqual([...urls])
})

test("resource display does not expand GitHub targets already distinguished by lines, query or fragment", () => {
  const urls = [
    github,
    github.replace("#L289-L327", "#L290-L328"),
    github.replace("#L289-L327", "?plain=1#L289-L327"),
    github.replace("#L289-L327", "#other-section"),
  ]
  const peers = urls.map(ResourceReference.parse)
  expect(peers.map((reference) => resourceDisplay(reference, peers).label)).toEqual([
    "deepseek-harness / index.ts:289–327",
    "deepseek-harness / index.ts:290–328",
    "deepseek-harness / index.ts:289–327?plain=1",
    "deepseek-harness / index.ts#other-section",
  ])
})

test("resource display narrows context independently within each owner and leaves unrelated targets compact", () => {
  const urls = [
    "https://github.com/first/repo/blob/main/a/index.ts#L2",
    "https://github.com/first/repo/blob/main/b/index.ts#L2",
    "https://github.com/second/repo/blob/main/a/index.ts#L2",
    "https://github.com/first/other/blob/main/a/index.ts#L2",
    "https://github.com/first/repo/blob/main/a/index.ts#L3",
    "https://example.org/index.ts#L2",
  ]
  const peers = urls.map(ResourceReference.parse)
  expect(peers.map((reference) => resourceDisplay(reference, peers).label)).toEqual([
    "first/repo / a/index.ts:2",
    "first/repo / b/index.ts:2",
    "second/repo / index.ts:2",
    "other / index.ts:2",
    "repo / index.ts:3",
    "example.org/index.ts#L2",
  ])
  expect(resourceDisplay(peers[0]!).label).toBe("repo / index.ts:2")
})

test("resource display keeps root files distinct from longer paths with the same suffix", () => {
  const peers = [
    "https://github.com/org/repo/blob/main/index.ts#L2",
    "https://github.com/org/repo/blob/main/src/index.ts#L2",
    "https://github.com/org/repo/blob/main/packages/src/index.ts#L2",
  ].map(ResourceReference.parse)
  expect(peers.map((reference) => resourceDisplay(reference, peers).label)).toEqual([
    "repo / ./index.ts:2",
    "repo / ./src/index.ts:2",
    "repo / packages/src/index.ts:2",
  ])
})

test("resource display retains distinguishing branch segments and query values without mutating targets", () => {
  const urls = [
    "https://github.com/org/repo/blob/feature/first/src/index.ts?view=one#L2-L4",
    "https://github.com/org/repo/blob/feature/second/src/index.ts?view=one#L2-L4",
    "https://github.com/org/repo/blob/feature/first/src/index.ts?view=two#L2-L4",
    "https://github.com/org/repo/blob/feature/first/src/index.ts?view=one#part-one",
    "https://github.com/org/repo/blob/feature/first/src/index.ts?view=one#part-two",
  ]
  const peers = Object.freeze(urls.map((url) => Object.freeze(ResourceReference.parse(url))))
  expect(peers.map((reference) => resourceDisplay(reference, peers).label)).toEqual([
    "repo / first/src/index.ts:2–4?view=one",
    "repo / second/src/index.ts:2–4?view=one",
    "repo / index.ts:2–4?view=two",
    "repo / index.ts?view=one#part-one",
    "repo / index.ts?view=one#part-two",
  ])
  expect(peers.map((reference) => ResourceReference.format(reference))).toEqual(urls)
})

test("resource display leaves notes, file locations, system protocols and unavailable resources explicit", () => {
  expect(resourceDisplay(ResourceReference.parse("note://nte_example#stable-block"))).toMatchObject({
    label: "nte_example",
    icon: "notes.main",
  })
  expect(resourceDisplay(ResourceReference.parse("src/a.ts#L2-L4"))).toMatchObject({
    label: "src/a.ts:2–4",
    file: "src/a.ts",
  })
  expect(resourceDisplay(ResourceReference.parse("mailto:hello@example.org"))).toMatchObject({
    label: "mailto:hello@example.org",
  })
  expect(resourceDisplay(ResourceReference.parse("asset://0123456789abcdef.md"))).toMatchObject({
    file: "asset://0123456789abcdef.md",
  })
  expect(resourceDisplay(ResourceReference.parse("#heading"))).toMatchObject({ label: "heading" })
  expect(resourceDisplay(ResourceReference.parse("javascript:unsafe()"))).toMatchObject({
    label: "javascript:unsafe()",
  })
})
