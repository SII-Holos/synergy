import { createEffect, createResource, onCleanup } from "solid-js"
import { useLingui } from "@lingui/solid"
import { useMarked } from "../context/marked"
import { useResourceOpen } from "../context/resource-open"
import { enhanceMarkdown } from "./markdown"
import { sanitizeHtml } from "./markdown-sanitize"
import type { UserMarkdownReference } from "./user-markdown-model"

export function UserMarkdown(props: {
  text: string
  references?: UserMarkdownReference[]
  onOpenReference?: (index: number) => void
}) {
  const marked = useMarked()
  const resourceOpen = useResourceOpen()
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
        if (url) resourceOpen?.open({ kind: "url", url, mime: "image/*", filename: button.textContent ?? undefined })
      }}
    />
  )
}
