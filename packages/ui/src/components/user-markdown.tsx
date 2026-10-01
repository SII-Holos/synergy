import { createEffect, createResource, onCleanup } from "solid-js"
import { useLingui } from "@lingui/solid"
import { useMarked } from "../context/marked"
import { useResourceOpen } from "../context/resource-open"
import { enhanceMarkdown } from "./markdown"
import { sanitizeHtml } from "./markdown-sanitize"
import { renderUserMarkdown, userMarkdownImageUrl, type UserMarkdownReference } from "./user-markdown-model"

export function UserMarkdown(props: {
  text: string
  references?: UserMarkdownReference[]
  onOpenReference?: (index: number) => void
}) {
  const marked = useMarked()
  const resourceOpen = useResourceOpen()
  const { _ } = useLingui()
  let root!: HTMLDivElement
  const key = () => JSON.stringify([props.text, props.references ?? []])
  const [rendered] = createResource(key, async (current) => ({
    key: current,
    html: sanitizeHtml(
      await renderUserMarkdown(props.text, props.references ?? [], async (raw, inline) =>
        String(await (inline ? marked.parseInline(raw) : marked.parse(raw))),
      ),
    ),
  }))
  createEffect(() => {
    const value = rendered()
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
      onClick={(event) => {
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
        const url = userMarkdownImageUrl(button.dataset.userImage ?? "")
        if (url) resourceOpen?.open({ kind: "url", url, mime: "image/*", filename: button.textContent ?? undefined })
      }}
    />
  )
}
