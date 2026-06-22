import type { BrowserAnnotation, BrowserAnnotationInput } from "./types.js"

export namespace BrowserAnnotationHelper {
  export function create(input: BrowserAnnotationInput): BrowserAnnotation {
    return {
      id: crypto.randomUUID(),
      tabURL: input.tabURL ?? "",
      tabID: input.tabID ?? "",
      ref: input.ref,
      element: input.element,
      comment: input.comment,
      styleFeedback: input.styleFeedback,
      resolved: false,
      createdAt: Date.now(),
    }
  }

  export function formatForContext(annotations: BrowserAnnotation[]): string {
    const pending = annotations.filter((a) => !a.resolved)
    if (pending.length === 0) return ""
    const items = pending
      .map(
        (a) =>
          `  <browser-annotation id="${a.id}"${a.ref ? ` ref="${a.ref}"` : ""}${a.element ? ` element="${a.element}"` : ""}${a.tabURL ? ` tab="${a.tabURL}"` : ""}>\n    ${a.comment}${a.styleFeedback ? `\n    style-feedback: ${JSON.stringify(a.styleFeedback)}` : ""}\n  </browser-annotation>`,
      )
      .join("\n")
    return `<browser-annotations>\n${items}\n</browser-annotations>`
  }
}
