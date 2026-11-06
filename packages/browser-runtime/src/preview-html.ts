import { BrowserPreviewFailure } from "./preview-types"

function decode(value: string) {
  return value.replace(/&(#(?:x[\da-f]+|\d+)|[a-z]+);/gi, (_match, entity: string) => {
    if (entity.startsWith("#")) {
      const point = entity[1]?.toLowerCase() === "x" ? Number.parseInt(entity.slice(2), 16) : Number(entity.slice(1))
      return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : "�"
    }
    return (
      ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " } as Record<string, string>)[
        entity.toLowerCase()
      ] ?? `&${entity};`
    )
  })
}

function text(value: string) {
  return decode(value)
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

export async function previewHTML(bytes: Uint8Array) {
  let title = ""
  let description = ""
  let openGraphDescription = ""
  let password = false
  let challenge = false
  let refresh = false
  const parsed = new HTMLRewriter()
    .on("head title", {
      text(chunk) {
        title += chunk.text
      },
    })
    .on("head meta", {
      element(element) {
        const name = (element.getAttribute("name") ?? element.getAttribute("property") ?? "").toLowerCase()
        const content = element.getAttribute("content") ?? ""
        if (name === "description" && !description) description = content
        if (name === "og:description" && !openGraphDescription) openGraphDescription = content
        if (element.getAttribute("http-equiv")?.toLowerCase() === "refresh") refresh = true
      },
    })
    .on("input", {
      element(element) {
        if (element.getAttribute("type")?.toLowerCase() === "password") password = true
      },
    })
    .on("iframe, script, form", {
      element(element) {
        const target = element.getAttribute("src") ?? element.getAttribute("action") ?? ""
        if (/recaptcha|hcaptcha|challenges\.cloudflare\.com|cdn-cgi\/challenge/i.test(target)) challenge = true
      },
    })
    .transform(new Response(new TextDecoder().decode(bytes)))
  await parsed.arrayBuffer()
  title = text(title)
  description = text(description || openGraphDescription)
  const combined = `${title} ${description}`
  if (
    challenge ||
    /just a moment|verify (?:that )?you are human|checking your browser|attention required|captcha|robot check|security verification/i.test(
      combined,
    )
  ) {
    throw new BrowserPreviewFailure("bot_challenge")
  }
  if (
    password ||
    /^(?:sign[ -]?in|log[ -]?in|authentication required|access denied|登录|登入)(?:\b|[：\s])/i.test(title)
  ) {
    throw new BrowserPreviewFailure("authentication_required")
  }
  if (refresh) throw new BrowserPreviewFailure("target_changed")
  if (!title && !description) throw new BrowserPreviewFailure("empty_metadata")
  return { title, ...(description ? { description } : {}) }
}
