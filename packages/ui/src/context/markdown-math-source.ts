import { generateUUID } from "@ericsanchezok/synergy-util/uuid"

const generatedKatexAttribute = "data-synergy-katex-generated"
let generatedKatexMarker = generateUUID()
export const markdownMathMarker = () => generatedKatexMarker
export const useMarkdownMathMarker = (marker: string) => {
  generatedKatexMarker = marker
}
const rawGeneratedKatexAttributeRule = new RegExp(
  `\\s${generatedKatexAttribute}(?:\\s*=\\s*(?:"[^"]*"|'[^']*'|[^\\s>]+))?`,
  "gi",
)

export function stripGeneratedKatexMarker(html: string) {
  return html.replace(rawGeneratedKatexAttributeRule, "")
}

export function getGeneratedKatexSource(element: Element) {
  if (element.getAttribute(generatedKatexAttribute) !== generatedKatexMarker) return
  const annotation = element.querySelector('annotation[encoding="application/x-tex"]')
  const source = annotation?.textContent?.trim()
  return source || undefined
}

export function markKatexHtml(html: string) {
  return html.replace("<span ", `<span ${generatedKatexAttribute}="${generatedKatexMarker}" `)
}
