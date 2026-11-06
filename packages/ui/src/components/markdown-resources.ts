import { ResourceReference } from "@ericsanchezok/synergy-util/resource-reference"
import type { ResourceAvailability, ResourceOpenController } from "../context/resource-open"
import { getOwner, runWithOwner } from "solid-js"
import { decorateMarkdownResource } from "./markdown-resource-decoration"
import { resourceDisplay } from "./resource-display"
import { revealMarkdownHeading } from "./markdown-navigation"

const bindingSelector = [
  "a[data-resource-reference]",
  "a[href]",
  "audio[data-resource-reference]",
  "img[data-resource-reference]",
  "img[src]",
  "source[data-resource-reference]",
  "track[data-resource-reference]",
  "video[data-resource-reference]",
  '[data-slot="markdown-resource-frame"]',
].join(", ")

// Media and frames keep their native interaction (controls, playback), so only
// an image or an explicit reference carrier opens a resource on click.
const activationSelector =
  'a[data-resource-reference], img[data-resource-reference], [data-slot="markdown-resource-frame"]'

const mediaTags = new Set(["AUDIO", "SOURCE", "TRACK", "VIDEO"])

type Unavailable = Extract<ResourceAvailability, { state: "unavailable" }>

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
  const unavailable = new Map<string, Unavailable>()
  const inspections = new Map<string, Promise<ResourceAvailability>>()
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

  // A reference whose target cannot be served is shown as an explicit block
  // carrying the path and the reason. Rendering it as a broken image or a live
  // link hid the failure behind "nothing happened" on click.
  const unavailableBlock = (value: string, availability: Unavailable) => {
    const document = root.ownerDocument
    const block = document.createElement("span")
    block.dataset.slot = "markdown-reference-unavailable"
    block.dataset.resourceUnavailable = availability.code
    block.setAttribute("role", "note")
    const path = document.createElement("span")
    path.dataset.slot = "markdown-reference-unavailable-path"
    path.textContent = availability.path ?? value
    const reason = document.createElement("span")
    reason.dataset.slot = "markdown-reference-unavailable-reason"
    reason.textContent = availability.reason
    block.append(path, reason)
    block.title = `${path.textContent} — ${reason.textContent}`
    return block
  }
  const replaceUnavailable = (element: Element, value: string, availability: Unavailable) => {
    if (!root.contains(element)) return
    const target =
      element.tagName === "IMG" ? (element.closest('a[data-slot="markdown-resource-image"]') ?? element) : element
    target.replaceWith(unavailableBlock(value, availability))
  }
  const referenceKey = (value: string) => `${value}\u0000${JSON.stringify(context())}`

  /** Resolves whether the target can still be served before anything is drawn,
   *  so an ignored or missing path never flashes as a broken image first. One
   *  inspection is shared by every occurrence of the same reference. */
  const inspectAvailability = (value: string, reference: ResourceReference.Target) => {
    if (!resources.inspectReference) return
    if (reference.kind !== "asset" && reference.kind !== "workspace-file") return
    const key = referenceKey(value)
    const pending = inspections.get(key)
    if (pending) return pending
    const inspection = resources
      .inspectReference(reference, context())
      .then((availability) => {
        if (availability.state === "unavailable") unavailable.set(key, availability)
        return availability
      })
      .catch((): ResourceAvailability => ({ state: "available" }))
    inspections.set(key, inspection)
    return inspection
  }
  /** `inspect` is on for references that render as media, where a missing target
   *  is visibly a broken frame. A text citation stays lazy: inspecting every one
   *  would issue a request per reference in long documents, and its failure is
   *  already reported when it is opened. */
  const whenAvailable = (
    element: Element,
    value: string,
    reference: ResourceReference.Target,
    apply: () => void,
    inspect: boolean,
  ) => {
    const inspection = inspect ? inspectAvailability(value, reference) : undefined
    if (!inspection) {
      apply()
      return
    }
    void inspection.then((availability) => {
      if (disposed || !root.contains(element)) return
      if (availability?.state === "unavailable") replaceUnavailable(element, value, availability)
      else apply()
    })
  }
  const bindImage = (element: Element, value: string, reference: ResourceReference.Target) =>
    whenAvailable(
      element,
      value,
      reference,
      () => {
        const url =
          reference.kind === "image" || (reference.kind === "url" && /^https?:/i.test(reference.url))
            ? reference.url
            : resources.resolveUrl?.(reference, context())
        if (url && element.getAttribute("src") !== url) {
          element.setAttribute("decoding", "async")
          element.setAttribute("src", url)
        } else if (!url) element.removeAttribute("src")
        if (element.closest("a")) return
        const link = root.ownerDocument.createElement("a")
        link.dataset.resourceReference = value
        link.dataset.slot = "markdown-resource-image"
        element.replaceWith(link)
        link.append(element)
        bind(link)
      },
      true,
    )
  const bindMedia = (element: Element, value: string, reference: ResourceReference.Target) => {
    const attribute = element.getAttribute("data-resource-attribute") ?? "src"
    whenAvailable(
      element,
      value,
      reference,
      () => {
        const url = resources.resolveUrl?.(reference, context())
        if (url && element.getAttribute(attribute) !== url) element.setAttribute(attribute, url)
        element.setAttribute("data-resource-kind", reference.kind)
      },
      true,
    )
  }
  const bindLink = (element: Element, value: string, reference: ResourceReference.Target) =>
    whenAvailable(
      element,
      value,
      reference,
      () => {
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
        if (!(element instanceof view.HTMLElement)) return
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
      },
      false,
    )
  const bind = (element: Element) => {
    // A sanitized `<iframe>`/`<object>`/`<embed>` leaves an inert carrier; turn it
    // into the same openable link a Markdown document reference produces.
    if (element.getAttribute("data-slot") === "markdown-resource-frame") {
      const value = element.getAttribute("data-resource-reference")
      if (!value) return
      const reference = ResourceReference.parse(value)
      const anchor = root.ownerDocument.createElement("a")
      anchor.dataset.resourceReference = value
      anchor.dataset.resourceFrame = "true"
      anchor.textContent = resourceDisplay(reference).label || value
      element.replaceWith(anchor)
      bind(anchor)
      return
    }
    const attribute = element.getAttribute("data-resource-attribute") ?? (element.tagName === "A" ? "href" : "src")
    const value = element.getAttribute("data-resource-reference") ?? element.getAttribute(attribute)
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
    if (element.tagName === "IMG") return bindImage(element, value, reference)
    if (mediaTags.has(element.tagName)) return bindMedia(element, value, reference)
    return bindLink(element, value, reference)
  }
  const visit = (node: Node) => {
    if (!(node instanceof view.Element)) return
    if (node.matches(bindingSelector)) bind(node)
    for (const element of node.querySelectorAll(bindingSelector)) bind(element)
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
    const known = unavailable.get(referenceKey(value))
    if (known) {
      replaceUnavailable(image, value, known)
      return
    }
    // The target exists but cannot decode as an image — a non-image attachment
    // authored with image syntax, for example. Degrade to an openable link so
    // the resource stays reachable instead of leaving a broken image behind.
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
    const clicked = event.target instanceof view.Element ? event.target.closest(activationSelector) : undefined
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
    unavailable.clear()
    root.removeEventListener("error", imageError, true)
    for (const element of busy) element.removeAttribute("aria-busy")
    busy.clear()
    root.removeEventListener("click", open)
    root.removeEventListener("auxclick", open)
    root.removeEventListener("keydown", key)
  }
}
