import { ResourceReference } from "@ericsanchezok/synergy-util/resource-reference"
import { LinguiContext } from "@lingui/solid"
import { createEffect, getOwner, useContext } from "solid-js"
import { render } from "solid-js/web"
import { Icon } from "./icon"
import { ResourceIcon } from "./resource-icon"
import { getSemanticIcon } from "./semantic-icon"
import { resourceDisplay } from "./resource-display"

export function decorateMarkdownResource(element: HTMLElement, reference: ResourceReference.Target) {
  const owner = getOwner()
  const display = resourceDisplay(reference)
  if (
    element.getAttribute("data-resource-bare") === "true" &&
    reference.kind === "url" &&
    /^https?:/i.test(reference.url)
  )
    element.dataset.resourceLabel = display.label
  const icon = element.ownerDocument.createElement("span")
  icon.dataset.referenceDecoration = ""
  icon.setAttribute("contenteditable", "false")
  element.prepend(icon)
  const disposeIcon = render(() => <ResourceIcon reference={reference} />, icon, undefined, { owner })
  const existing = element.querySelector<HTMLElement>("[data-reference-text]")
  const label = existing ?? element.ownerDocument.createElement("span")
  label.dataset.referenceText = ""
  if (!existing) {
    const selection = element.ownerDocument.getSelection()
    const ranges = Array.from({ length: selection?.rangeCount ?? 0 }, (_, index) => ({
      start: selection!.getRangeAt(index).startContainer,
      startOffset: selection!.getRangeAt(index).startOffset,
      end: selection!.getRangeAt(index).endContainer,
      endOffset: selection!.getRangeAt(index).endOffset,
    }))
    for (const node of [...element.childNodes]) if (node !== icon) label.append(node)
    element.append(label)
    for (const [index, range] of ranges.entries()) {
      const current = selection?.getRangeAt(index)
      if (current) {
        current.setStart(range.start, range.startOffset)
        current.setEnd(range.end, range.endOffset)
      }
    }
  }
  const info = element.ownerDocument.createElement("button")
  info.type = "button"
  info.dataset.resourceInfo = ""
  info.tabIndex = -1
  const disposeInfo = render(
    () => {
      const lingui = useContext(LinguiContext)
      createEffect(() =>
        info.setAttribute(
          "aria-label",
          lingui?._({ id: "ui.resource.preview", message: "Preview reference" }) ?? "Preview reference",
        ),
      )
      return <Icon name={getSemanticIcon("action.info")} size="small" />
    },
    info,
    undefined,
    { owner },
  )
  element.after(info)
  return () => {
    disposeIcon()
    disposeInfo()
    icon.remove()
    info.remove()
  }
}
