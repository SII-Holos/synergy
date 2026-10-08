import { ResourceReference } from "@ericsanchezok/synergy-util/resource-reference"
import type { ResourceOpenController } from "../context/resource-open"
import { chooseIconName } from "./file-icons/model"
import sprite from "./file-icons/sprite.svg"
import { revealMarkdownHeading } from "./markdown-navigation"

const selector = "a[data-resource-reference], img[data-resource-reference], a[href], img[src]"

export function observeMarkdownResources(
  root: HTMLElement,
  resources: ResourceOpenController,
  context: () => ResourceReference.Context = () => ({ state: "unresolved" }),
) {
  const view = root.ownerDocument.defaultView
  if (!view) return () => {}
  let disposed = false
  const activations = new WeakMap<Element, object>()
  const busy = new Set<Element>()
  const bind = (element: Element) => {
    const value =
      element.getAttribute("data-resource-reference") ??
      element.getAttribute(element.tagName === "IMG" ? "src" : "href")
    if (!value) {
      if (element.tagName === "A" && element.getAttribute("href")?.startsWith("#")) element.removeAttribute("target")
      return
    }
    const reference = ResourceReference.parse(value)
    if (element.tagName === "A" && !element.hasAttribute("data-resource-reference")) {
      if (reference.kind === "url") return
      if (reference.kind === "anchor") {
        element.removeAttribute("target")
        return
      }
    }
    if (!element.hasAttribute("data-resource-reference")) element.setAttribute("data-resource-reference", value)
    if (element.tagName === "IMG") {
      const url =
        reference.kind === "image" || (reference.kind === "url" && /^https?:/i.test(reference.url))
          ? reference.url
          : resources.resolveUrl?.(reference, context())
      if (url && element.getAttribute("src") !== url) {
        element.setAttribute("decoding", "async")
        element.setAttribute("src", url)
      } else if (!url) element.removeAttribute("src")
      if (!element.closest("a")) {
        const link = root.ownerDocument.createElement("a")
        link.dataset.resourceReference = value
        link.dataset.slot = "markdown-resource-image"
        element.replaceWith(link)
        link.append(element)
        bind(link)
      }
      return
    }
    element.removeAttribute("href")
    element.removeAttribute("target")
    element.setAttribute("role", "button")
    element.setAttribute("tabindex", "0")
    element.setAttribute("title", value)
    element.setAttribute("data-resource-kind", reference.kind)
    element.setAttribute("data-resource-bound", "true")
    if (element.querySelector("img") || element.querySelector("[data-reference-icon]")) return
    if (reference.kind !== "workspace-file" && reference.kind !== "asset") return
    const svg = root.ownerDocument.createElementNS("http://www.w3.org/2000/svg", "svg")
    svg.setAttribute("data-reference-icon", "")
    svg.setAttribute("aria-hidden", "true")
    svg.setAttribute("focusable", "false")
    const use = root.ownerDocument.createElementNS("http://www.w3.org/2000/svg", "use")
    const path = reference.kind === "workspace-file" ? reference.path : reference.url
    use.setAttribute("href", `${sprite}#${chooseIconName(path, path.endsWith("/") ? "directory" : "file", false)}`)
    svg.append(use)
    element.prepend(svg)
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
    attributeFilter: ["data-resource-reference", "href"],
  })
  visit(root)
  const open = (event: MouseEvent | KeyboardEvent) => {
    if (event.defaultPrevented || (event instanceof view.KeyboardEvent && event.repeat)) return
    if (event instanceof view.MouseEvent && event.button > 1) return
    const clicked = event.target instanceof view.Element ? event.target.closest(selector) : undefined
    if (!clicked || !root.contains(clicked) || clicked.closest("[inert]")) return
    if (clicked.matches('a[href^="#"]')) {
      event.preventDefault()
      const target = ResourceReference.parse(clicked.getAttribute("href")!)
      if (target.kind === "anchor") revealMarkdownHeading(root, target.id)
      return
    }
    const anchor = clicked.closest("a")
    if (anchor?.hasAttribute("href") && !anchor.hasAttribute("data-resource-reference")) return
    const element = anchor ?? clicked
    const value = element.getAttribute("data-resource-reference")
    if (!value) return
    event.preventDefault()
    const peers = () =>
      Array.from(root.querySelectorAll<HTMLElement>("a[data-resource-reference]")).filter(
        (item) => item.dataset.resourceReference === value && !item.closest("[inert]"),
      )
    const occurrence = Math.max(0, peers().indexOf(element as HTMLElement))
    const reference = ResourceReference.parse(value)
    const image = element.querySelector("img")
    element.setAttribute("aria-busy", "true")
    const activation = {}
    activations.set(element, activation)
    busy.add(element)
    void resources
      .open(
        {
          ...reference,
          filename: (image?.getAttribute("alt") ?? element.textContent)?.trim() || undefined,
          ...(image ? { mime: "image/*" } : {}),
        },
        {
          context: context(),
          focusTarget: () => peers()[occurrence],
          newTab: event.ctrlKey || event.metaKey || (event instanceof view.MouseEvent && event.button === 1),
          prefer: image ? "preview" : "workspace",
        },
      )
      .then((result) => {
        if (disposed || activations.get(element) !== activation) return
        element.removeAttribute("aria-busy")
        busy.delete(element)
        element.setAttribute("data-resource-state", result.status)
      })
      .catch(() => {
        if (disposed || activations.get(element) !== activation) return
        element.removeAttribute("aria-busy")
        busy.delete(element)
        element.setAttribute("data-resource-state", "unavailable")
      })
  }
  const key = (event: KeyboardEvent) => {
    if (event.key === "Enter" || event.key === " ") open(event)
  }
  root.addEventListener("click", open)
  root.addEventListener("auxclick", open)
  root.addEventListener("keydown", key)
  return () => {
    disposed = true
    observer.disconnect()
    for (const element of busy) element.removeAttribute("aria-busy")
    busy.clear()
    root.removeEventListener("click", open)
    root.removeEventListener("auxclick", open)
    root.removeEventListener("keydown", key)
  }
}
