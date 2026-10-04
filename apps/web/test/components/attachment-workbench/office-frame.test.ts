import { expect, test } from "bun:test"
import { officePreviewDocument } from "../../../src/components/attachment-workbench/office-frame"

test("Office frames retain readable embedded content and isolate active or external resources", () => {
  const html = officePreviewDocument(
    '<section><h1>中文内容</h1><img src="data:image/png;base64,AA=="><img src="https://example.com/tracker"><a href="https://example.com">外部链接文本</a><script>alert(1)</script><div style="background:url(https://example.com/tracker)">内容</div></section>',
    '@import url("https://example.com/styles"); section{color:red}',
    1,
    "内容",
  )
  expect(html).toContain("default-src 'none'")
  expect(html).toContain("script-src 'none'")
  expect(html).toContain("data:image/png")
  expect(html).toContain("<mark>内容</mark>")
  expect(html).not.toContain("https://example.com")
  expect(html).not.toContain("<script")
})

test("Office search follows text runs and keeps SVG highlights in the SVG namespace", () => {
  const html = officePreviewDocument(
    "<p><span>中文</span><b>内容</b></p><svg><text>中文内容</text></svg>",
    "",
    1,
    "中文内容",
  )
  const host = document.createElement("div")
  host.innerHTML = html
  expect(Array.from(host.querySelectorAll(".office-paper mark")).map((node) => node.textContent)).toEqual([
    "中文",
    "内容",
  ])
  const highlight = host.querySelector("svg text tspan")
  expect(highlight?.textContent).toBe("中文内容")
  expect(highlight?.namespaceURI).toBe("http://www.w3.org/2000/svg")
})

test("Office SVG retains text integration points while removing animation and active content", () => {
  const html = officePreviewDocument(
    '<svg><foreignObject><div xmlns="http://www.w3.org/1999/xhtml"><p onclick="alert(1)">中文幻灯片<script>alert(1)</script><img src="https://example.com/image"></p></div></foreignObject><animate attributeName="x"/><set attributeName="href" to="https://example.com"/></svg>',
    "",
  )
  expect(html).toContain("中文幻灯片")
  expect(html).not.toContain("<script")
  expect(html).not.toContain("onclick")
  expect(html).not.toContain("<animate")
  expect(html).not.toContain("<set")
  expect(html).not.toContain("https://example.com")
})
