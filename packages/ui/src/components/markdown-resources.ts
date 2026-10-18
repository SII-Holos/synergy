import { ResourceReference } from "@ericsanchezok/synergy-util/resource-reference"
import type { ResourceOpenController } from "../context/resource-open"
import { getOwner, runWithOwner } from "solid-js"
import { decorateMarkdownResource } from "./markdown-resource-decoration"
import { resourceDisplay } from "./resource-display"
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
  const owner = getOwner()
  const activations = new WeakMap<Element, object>()
  const busy = new Set<Element>()
  const decorations = new Map<HTMLElement, () => void>()
  const githubLabels = new Map<string, Map<HTMLElement, ResourceReference.Target>>()
  const labelGroups = new WeakMap<HTMLElement, string>()
  const dirtyLabels = new Set<string>()
  const refreshLabels = () => {
    for (const key of dirtyLabels) {
      const peers = githubLabels.get(key)
      if (!peers) continue
      const targets = [...peers.values()]
      for (const [element, reference] of peers) {
        const label = resourceDisplay(reference, targets).label
        if (element.dataset.resourceLabel !== label) element.dataset.resourceLabel = label
      }
    }
    dirtyLabels.clear()
  }
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
    if (reference.kind !== "url") {
      element.removeAttribute("href")
      element.removeAttribute("target")
      element.setAttribute("role", "button")
    }
    element.setAttribute("tabindex", "0")
    const image = element.querySelector("img")
    const title = image || reference.kind === "image" ? undefined : value
    if (title) element.setAttribute("title", title)
    else element.removeAttribute("title")
    element.setAttribute("data-resource-kind", reference.kind)
    element.setAttribute("data-resource-bound", "true")
    if (
      element.querySelector("img") ||
      element.querySelector("[data-reference-icon]") ||
      reference.kind === "unavailable"
    )
      return
    if (element instanceof view.HTMLElement) {
      const dispose = runWithOwner(owner, () => decorateMarkdownResource(element, reference))
      if (dispose) decorations.set(element, dispose)
      const display = resourceDisplay(reference)
      if (element.hasAttribute("data-resource-label") && display.disambiguatedLabel) {
        const key = display.label
        const peers = githubLabels.get(key) ?? new Map<HTMLElement, ResourceReference.Target>()
        peers.set(element, reference)
        githubLabels.set(key, peers)
        labelGroups.set(element, key)
        dirtyLabels.add(key)
      }
    }
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
    for (const [element, dispose] of decorations)
      if (!root.contains(element)) {
        dispose()
        decorations.delete(element)
        const key = labelGroups.get(element)
        if (key) {
          const peers = githubLabels.get(key)
          peers?.delete(element)
          if (!peers?.size) githubLabels.delete(key)
          else dirtyLabels.add(key)
          labelGroups.delete(element)
        }
      }
    refreshLabels()
  })
  const imageError = (event: Event) => {
    const image = event.target
    if (!(image instanceof view.HTMLImageElement)) return
    const value = image.dataset.resourceReference
    if (!value) return
    const reference = ResourceReference.parse(value)
    if (reference.kind !== "asset" && reference.kind !== "workspace-file") return
    const link = image.closest("a[data-resource-reference]")
    if (!link || !root.contains(link)) return
    image.replaceWith(root.ownerDocument.createTextNode(image.alt || value))
    link.removeAttribute("data-slot")
    bind(link)
  }
  root.addEventListener("error", imageError, true)
  observer.observe(root, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["data-resource-reference", "href"],
  })
  visit(root)
  refreshLabels()
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
    const reference = ResourceReference.parse(value)
    const image = element.querySelector("img")
    if (
      reference.kind === "url" &&
      /^https?:/i.test(reference.url) &&
      !image &&
      anchor?.getAttribute("href") === reference.url &&
      resources.nativeLink?.(reference)
    )
      return
    event.preventDefault()
    const peers = () =>
      Array.from(root.querySelectorAll<HTMLElement>("a[data-resource-reference]")).filter(
        (item) => item.dataset.resourceReference === value && !item.closest("[inert]"),
      )
    const occurrence = Math.max(0, peers().indexOf(element as HTMLElement))
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
    if (event.key === " " && event.target instanceof view.Element && event.target.closest("a[href]")) return
    if (event.key === "Enter" || event.key === " ") open(event)
  }
  root.addEventListener("click", open)
  root.addEventListener("auxclick", open)
  root.addEventListener("keydown", key)
  return () => {
    disposed = true
    observer.disconnect()
    for (const dispose of decorations.values()) dispose()
    decorations.clear()
    githubLabels.clear()
    dirtyLabels.clear()
    root.removeEventListener("error", imageError, true)
    for (const element of busy) element.removeAttribute("aria-busy")
    busy.clear()
    root.removeEventListener("click", open)
    root.removeEventListener("auxclick", open)
    root.removeEventListener("keydown", key)
  }
}
