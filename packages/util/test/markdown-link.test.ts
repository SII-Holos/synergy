import { expect, test } from "bun:test"
import { bareUrlEnd, isBareUrlBoundary } from "../src/markdown-link"

test("bare URL boundaries use the exact Chinese punctuation set without changing Chinese paths or ASCII punctuation", () => {
  for (const punctuation of "，。；！？、：“”‘’「」『』《》【】（）") {
    expect(bareUrlEnd(`https://example.org/中文${punctuation}后文`)).toBe("https://example.org/中文".length)
    expect(isBareUrlBoundary(punctuation)).toBe(true)
  }
  for (const target of [
    "https://example.org/中文?q=查询#详情",
    "https://example.org/a_(b)?q=a,b",
    "www.example.org/%E4%B8%AD",
  ]) {
    expect(bareUrlEnd(target)).toBe(target.length)
    expect(isBareUrlBoundary(target)).toBe(false)
  }
})
