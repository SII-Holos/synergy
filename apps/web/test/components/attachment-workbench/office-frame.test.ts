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
