import DOMPurify from "dompurify"
import { createMemo } from "solid-js"

const officePurify = DOMPurify(window)
const officeCsp =
  "default-src 'none'; script-src 'none'; connect-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"

function safeCss(css: string) {
  return css
    .replace(/@import[\s\S]*?(?:;|$)/gi, "")
    .replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (_whole, _quote: string, url: string) =>
      /^(?:data:|#)/i.test(url.trim()) ? `url("${url.replaceAll('"', "%22")}")` : "none",
    )
    .replace(/<\/style/gi, "<\\/style")
}

export function sanitizeOfficeMarkup(html: string) {
  const template = document.createElement("template")
  template.innerHTML = String(
    officePurify.sanitize(html, {
      USE_PROFILES: { html: true, svg: true, svgFilters: true },
      ADD_TAGS: ["foreignObject"],
      HTML_INTEGRATION_POINTS: { foreignobject: true },
      FORBID_TAGS: [
        "script",
        "iframe",
        "object",
        "embed",
        "form",
        "input",
        "button",
        "link",
        "base",
        "meta",
        "audio",
        "video",
        "animate",
        "animateMotion",
        "animateTransform",
        "set",
        "discard",
      ],
      FORBID_ATTR: ["srcdoc"],
    }),
  )
  for (const element of template.content.querySelectorAll(
    "script, iframe, object, embed, form, input, button, link, base, meta, audio, video, animate, animateMotion, animateTransform, set, discard",
  ))
    element.remove()
  for (const element of template.content.querySelectorAll("*")) {
    for (const attribute of Array.from(element.attributes))
      if (attribute.name.toLowerCase().startsWith("on") || attribute.name === "srcdoc")
        element.removeAttribute(attribute.name)
    for (const name of ["src", "srcset", "href", "xlink:href", "poster"]) {
      const value = element.getAttribute(name)
      if (
        value &&
        !/^(?:data:image\/|data:font\/|data:application\/(?:font|x-font|octet-stream)|#)/i.test(value.trim())
      )
        element.removeAttribute(name)
    }
    if (element.hasAttribute("style")) element.setAttribute("style", safeCss(element.getAttribute("style")!))
    if (element.tagName.toLowerCase() === "style") element.textContent = safeCss(element.textContent ?? "")
  }
  return template.innerHTML
}

export function officePreviewDocument(html: string, css: string, scale = 1, search = "") {
  const template = document.createElement("template")
  template.innerHTML = sanitizeOfficeMarkup(html)
  if (search.trim()) {
    const nodes: Text[] = []
    const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_TEXT)
    while (walker.nextNode())
      if (!walker.currentNode.parentElement?.closest("style")) nodes.push(walker.currentNode as Text)
    const expression = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu")
    const matches = Array.from(
      nodes
        .map((node) => node.data)
        .join("")
        .matchAll(expression),
    )
    let offset = 0,
      matchIndex = 0
    for (const node of nodes) {
      const source = node.data
      while (matches[matchIndex] && matches[matchIndex]!.index + matches[matchIndex]![0].length <= offset) matchIndex++
      const ranges: { start: number; end: number }[] = []
      for (let index = matchIndex; index < matches.length; index++) {
        const match = matches[index]!
        if (match.index >= offset + source.length) break
        const start = Math.max(0, match.index - offset)
        const end = Math.min(source.length, match.index + match[0].length - offset)
        if (end > start) ranges.push({ start, end })
      }
      offset += source.length
      if (!ranges.length) continue
      const fragment = document.createDocumentFragment()
      let cursor = 0
      for (const { start, end } of ranges) {
        fragment.append(source.slice(cursor, start))
        const svg = node.parentElement?.namespaceURI === "http://www.w3.org/2000/svg"
        const mark = svg
          ? document.createElementNS("http://www.w3.org/2000/svg", "tspan")
          : document.createElement("mark")
        if (svg) mark.setAttribute("class", "office-search-match")
        mark.textContent = source.slice(start, end)
        fragment.append(mark)
        cursor = end
      }
      fragment.append(source.slice(cursor))
      node.replaceWith(fragment)
    }
  }
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${officeCsp}"><style>${safeCss(css)}\nhtml{color-scheme:light}body{margin:0; padding:16px; box-sizing:border-box; overflow:auto;} .office-paper{zoom:${Math.max(0.1, Math.min(4, scale))};width:max-content;margin:auto;} mark{background:Highlight;color:HighlightText;} .office-search-match{fill:Highlight;}</style></head><body><div class="office-paper">${template.innerHTML}</div></body></html>`
}

export function OfficeDocumentFrame(props: {
  html: string
  css?: string
  scale: number
  search?: string
  title: string
}) {
  const content = createMemo(() => officePreviewDocument(props.html, props.css ?? "", props.scale, props.search))
  return (
    <iframe
      class="office-document-frame"
      title={props.title}
      sandbox=""
      referrerpolicy="no-referrer"
      srcdoc={content()}
    />
  )
}
