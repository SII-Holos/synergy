import { createEffect, createResource, onCleanup } from "solid-js"
import { useLingui } from "@lingui/solid"
import { useMarked } from "../context/marked"
import { useReferenceContext, useResourceOpen } from "../context/resource-open"
import { ResourceReference } from "@ericsanchezok/synergy-util/resource-reference"
import { observeMarkdownResources } from "./markdown-resources"
import { enhanceMarkdown } from "./markdown"
import { sanitizeHtml } from "./markdown-sanitize"
import type { UserMarkdownReference } from "./user-markdown-model"

export function UserMarkdown(props: {
  text: string
  references?: UserMarkdownReference[]
  onOpenReference?: (index: number) => void
  referenceContext?: ResourceReference.Context
}) {
  const marked = useMarked()
  const resourceOpen = useResourceOpen()
  const inheritedContext = useReferenceContext()
  const context = () => props.referenceContext ?? inheritedContext() ?? { state: "unresolved" as const }
  const { _ } = useLingui()
  let root!: HTMLDivElement
  let pending: AbortController | undefined
  onCleanup(() => pending?.abort())
  const key = () => JSON.stringify([props.text, props.references ?? []])
  const [rendered] = createResource(key, async (current) => {
    pending?.abort()
    const controller = new AbortController()
    pending = controller
    const text = props.text,
      references = props.references ?? []
    const { renderUserMarkdown } = await import("./user-markdown-model")
    return {
      key: current,
      html: sanitizeHtml(
        await renderUserMarkdown(text, references, async (raw, inline) =>
          String(await (inline ? marked.parseInline(raw, controller.signal) : marked.parse(raw, controller.signal))),
        ),
      ),
    }
  })
  createEffect(() => {
    const value = rendered.error ? undefined : rendered()
    if (value?.key !== key()) {
      root.textContent = props.text
      return
    }
    root.innerHTML = value.html
    const dispose = enhanceMarkdown(root, _)
    onCleanup(dispose)
    if (resourceOpen) onCleanup(observeMarkdownResources(root, resourceOpen, context))
  })
  return (
    <div
      data-component="markdown"
      data-user-markdown
      ref={root}
      onClick={async (event) => {
        const button = (event.target as Element).closest<HTMLButtonElement>(
          "button[data-user-reference], button[data-user-image]",
        )
        if (!button || !root.contains(button)) return
        const reference = button.dataset.userReference
        if (reference !== undefined) {
          const index = Number(reference)
          if (Number.isInteger(index) && props.references?.[index]) props.onOpenReference?.(index)
          return
        }
        const { userMarkdownImageUrl } = await import("./user-markdown-model")
        if (!root.isConnected || !root.contains(button)) return
        const url = userMarkdownImageUrl(button.dataset.userImage ?? "")
        if (url)
          void resourceOpen?.open(
            { ...ResourceReference.parse(url), mime: "image/*", filename: button.textContent ?? undefined },
            { context: context(), prefer: "preview", focusTarget: () => button },
          )
      }}
    />
  )
}
