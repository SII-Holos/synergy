import { AssetReference } from "@ericsanchezok/synergy-util/asset-reference"
import type { ResourceOpenController } from "../context/resource-open"
import { resolveAttachmentUrl } from "./attachment-card-utils"

const selector = "a[data-resource-reference], img[data-resource-reference]"

export function observeMarkdownResources(root: HTMLElement, resources: ResourceOpenController) {
  const view = root.ownerDocument.defaultView
  if (!view || !resources.resolveAttachmentReference) return () => {}
  const resolved = new WeakMap<Element, string>()
  const resolve = (element: Element) => {
    const reference = element.getAttribute("data-resource-reference")
    if (!reference || !AssetReference.parse(reference)) return
    const filename =
      element.tagName === "IMG"
        ? element.getAttribute("alt")
        : element.textContent || element.querySelector("img")?.getAttribute("alt")
    return resources.resolveAttachmentReference?.(reference, filename || undefined)
  }
  const bind = (element: Element) => {
    const resource = resolve(element)
    if (!resource) return
    const url = resolveAttachmentUrl(resource.serverUrl, resource.file)
    if (!url || resolved.get(element) === url) return
    resolved.set(element, url)
    if (element.tagName === "IMG") {
      if (!resource.file.mime.startsWith("image/")) return
      element.setAttribute("src", url)
      element.setAttribute("loading", "lazy")
      element.setAttribute("decoding", "async")
      if (!element.closest("a")) {
        const link = root.ownerDocument.createElement("a")
        link.dataset.resourceReference = resource.file.url
        link.dataset.slot = "markdown-resource-image"
        link.href = url
        element.replaceWith(link)
        link.append(element)
      }
    } else {
      element.setAttribute("href", url)
    }
    element.setAttribute("data-resource-bound", "true")
  }
  const visit = (node: Node) => {
    if (!(node instanceof view.Element)) return
    if (node.matches(selector)) bind(node)
    for (const element of node.querySelectorAll(selector)) bind(element)
  }
  const observer = new view.MutationObserver((records) => {
    for (const record of records) {
      if (record.type === "attributes") visit(record.target)
      else for (const node of record.addedNodes) visit(node)
    }
  })
  observer.observe(root, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["data-resource-reference"],
  })
  visit(root)
  const open = (event: MouseEvent) => {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return
    const element = event.target instanceof view.Element ? event.target.closest(selector) : undefined
    if (!element || !root.contains(element)) return
    const resource = resolve(element)
    if (!resource) return
    const reference = element.getAttribute("data-resource-reference")!
    const focusTarget = () =>
      root.querySelector<HTMLAnchorElement>(`a[data-resource-reference="${reference}"]`) ?? undefined
    if (resources.openAttachment(resource.file, { serverUrl: resource.serverUrl, focusTarget })) event.preventDefault()
  }
  root.addEventListener("click", open)
  return () => {
    observer.disconnect()
    root.removeEventListener("click", open)
  }
}
