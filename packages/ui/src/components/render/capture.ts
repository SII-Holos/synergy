// Runs inside the opaque frame. A tainted or unsupported rasterization returns no image.
export async function captureRenderElement(element: Element): Promise<string | undefined> {
  try {
    const source = element instanceof SVGElement ? (element.ownerSVGElement ?? element) : element
    const rect = source.getBoundingClientRect()
    if (!rect.width || !rect.height || source.querySelectorAll("*").length > 500) return
    const scale = Math.min(1, 1024 / Math.max(rect.width, rect.height))
    const canvas = document.createElement("canvas")
    canvas.width = Math.max(1, Math.round(rect.width * scale))
    canvas.height = Math.max(1, Math.round(rect.height * scale))
    const context = canvas.getContext("2d")!
    if (source instanceof HTMLCanvasElement) context.drawImage(source, 0, 0, canvas.width, canvas.height)
    else {
      const copy = source.cloneNode(true) as Element
      const originals = [source, ...source.querySelectorAll("*")]
      const clones = [copy, ...copy.querySelectorAll("*")]
      for (let index = 0; index < originals.length; index++) {
        const original = originals[index],
          clone = clones[index]
        if (!(clone instanceof HTMLElement || clone instanceof SVGElement)) continue
        const style = getComputedStyle(original)
        for (const name of style) clone.style.setProperty(name, style.getPropertyValue(name))
        for (const attribute of Array.from(clone.attributes))
          if (/^on/i.test(attribute.name) || ["src", "href", "xlink:href"].includes(attribute.name))
            clone.removeAttribute(attribute.name)
      }
      copy.querySelectorAll("script, link, iframe, object, embed, video, audio").forEach((node) => node.remove())
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg")
      svg.setAttribute("width", String(rect.width))
      svg.setAttribute("height", String(rect.height))
      if (source instanceof SVGElement) {
        copy.setAttribute("width", String(rect.width))
        copy.setAttribute("height", String(rect.height))
        svg.append(copy)
      } else {
        const object = document.createElementNS(svg.namespaceURI, "foreignObject")
        object.setAttribute("width", "100%")
        object.setAttribute("height", "100%")
        object.append(copy)
        svg.append(object)
      }
      const xml = new XMLSerializer().serializeToString(svg)
      if (xml.length > 512 * 1024) return
      const image = new Image()
      await new Promise<void>((resolve, reject) => {
        const timer = window.setTimeout(() => {
          image.src = ""
          reject(new Error("capture timeout"))
        }, 1500)
        image.onload = () => {
          clearTimeout(timer)
          resolve()
        }
        image.onerror = () => {
          clearTimeout(timer)
          reject(new Error("capture unavailable"))
        }
        image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(xml)}`
      })
      context.drawImage(image, 0, 0, canvas.width, canvas.height)
    }
    const image = canvas.toDataURL("image/png")
    return image.length <= 350 * 1024 ? image : undefined
  } catch {
    return undefined
  }
}
