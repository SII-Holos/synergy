import { renderAsync } from "docx-preview"
import { createResource, onCleanup } from "solid-js"
import { createOfficeWorkerReader } from "./office-worker-client"
import { OfficePreviewError } from "./office-contract"
import { OfficePaginatedReader } from "./office-pages"

export async function renderDocxPages(bytes: Uint8Array) {
  const inert = document.implementation.createHTMLDocument()
  const body = inert.createElement("div"),
    styles = inert.createElement("div")
  await renderAsync(bytes, body, styles, {
    className: "office-docx",
    renderAltChunks: false,
    useBase64URL: true,
    breakPages: true,
    ignoreLastRenderedPageBreak: false,
    renderHeaders: true,
    renderFooters: true,
    ignoreFonts: false,
  })
  const pages = Array.from(body.querySelectorAll<HTMLElement>("section.office-docx")).map((section) => ({
    html: section.outerHTML,
    text: section.textContent ?? "",
    width: parseFloat(section.style.width || "595") * (section.style.width.endsWith("px") ? 1 : 4 / 3),
  }))
  if (!pages.length) throw new OfficePreviewError("corrupt")
  return {
    pages,
    css: Array.from(styles.querySelectorAll("style"))
      .map((style) => style.textContent ?? "")
      .join("\n"),
  }
}

export function DocxReader(props: { bytes: Uint8Array; filename?: string }) {
  const reader = createOfficeWorkerReader()
  let generation = 0
  const [content] = createResource(
    () => props.bytes,
    async (bytes) => {
      const current = ++generation
      const checked = await reader.read(bytes, "docx")
      const result = await renderDocxPages(checked.bytes)
      if (current !== generation) throw new DOMException("Cancelled", "AbortError")
      return result
    },
  )
  onCleanup(() => {
    generation++
    reader.cancel()
  })
  return (
    <OfficePaginatedReader
      document={content.error ? undefined : content()}
      error={content.error}
      loading={content.loading}
      filename={props.filename}
    />
  )
}
