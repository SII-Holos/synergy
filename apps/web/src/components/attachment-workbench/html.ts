import DOMPurify from "dompurify"

export function sanitizeAttachmentHtml(html: string) {
  const sanitized = String(
    DOMPurify.sanitize(html, {
      FORBID_TAGS: [
        "script",
        "iframe",
        "frame",
        "frameset",
        "object",
        "embed",
        "form",
        "input",
        "button",
        "select",
        "textarea",
      ],
      FORBID_ATTR: ["srcdoc"],
    }),
  )
  const template = document.createElement("template")
  template.innerHTML = sanitized
  for (const element of template.content.querySelectorAll(
    "script, iframe, frame, frameset, object, embed, form, input, button, select, textarea",
  )) {
    element.remove()
  }
  for (const element of template.content.querySelectorAll("*")) {
    for (const attribute of Array.from(element.attributes)) {
      if (attribute.name.toLowerCase().startsWith("on") || attribute.name.toLowerCase() === "srcdoc") {
        element.removeAttribute(attribute.name)
      }
    }
  }
  for (const element of template.content.querySelectorAll("img, audio, video, source, track")) {
    const src = element.getAttribute("src")
    if (src && !/^(?:data:|blob:)/i.test(src)) element.removeAttribute("src")
  }
  return template.innerHTML
}
