import { Virtualizer, WindowVirtualizer, type VirtualizerHandle, type WindowVirtualizerHandle } from "virtua/solid"
import { createSignal, onCleanup, onMount } from "solid-js"
import type { MarkdownBlock, MarkdownDocument } from "../context/markdown-document"
import { sanitizeHtml } from "./markdown-sanitize"
type CacheSnapshot = VirtualizerHandle["cache"]

function scrollContainer(root: HTMLElement) {
  for (let parent = root.parentElement; parent; parent = parent.parentElement) {
    if (["auto", "scroll"].includes(getComputedStyle(parent).overflowY)) return parent
  }
}

export function MarkdownDocumentView(props: {
  root: HTMLDivElement
  document: MarkdownDocument
  cache?: CacheSnapshot
  cacheUpdated(cache: CacheSnapshot): void
  enhance(root: HTMLDivElement, source?: string): () => void
}) {
  const scroller = scrollContainer(props.root)
  const [margin, setMargin] = createSignal(0)
  const [kept, setKept] = createSignal<number[]>([])
  let virtual: VirtualizerHandle | WindowVirtualizerHandle | undefined
  const pin = () => {
    const selected = new Set<number>()
    const add = (node: Node | null) => {
      const element = node instanceof Element ? node : node?.parentElement
      const block = element?.closest<HTMLElement>("[data-markdown-block]")
      if (block && props.root.contains(block)) selected.add(Number(block.dataset.markdownBlock))
    }
    add(document.activeElement)
    const selection = document.getSelection()
    if (selection && !selection.isCollapsed) {
      add(selection.anchorNode)
      add(selection.focusNode)
      const indices = [...selected]
      if (indices.length > 1)
        for (const block of props.root.querySelectorAll<HTMLElement>("[data-markdown-block]")) {
          const index = Number(block.dataset.markdownBlock)
          if (index >= Math.min(...indices) && index <= Math.max(...indices)) selected.add(index)
        }
    }
    setKept([...selected])
  }
  onMount(() => {
    const measure = () => {
      if (scroller)
        setMargin(props.root.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop)
    }
    const observer = new ResizeObserver(measure)
    if (props.root.parentElement) observer.observe(props.root.parentElement)
    if (scroller?.firstElementChild) observer.observe(scroller.firstElementChild)
    measure()
    scroller?.addEventListener("scroll", measure, { passive: true })
    props.root.addEventListener("load", measure, true)
    document.addEventListener("selectionchange", pin)
    document.addEventListener("focusin", pin)
    document.addEventListener("focusout", pin)
    onCleanup(() => {
      observer.disconnect()
      scroller?.removeEventListener("scroll", measure)
      props.root.removeEventListener("load", measure, true)
      document.removeEventListener("selectionchange", pin)
      document.removeEventListener("focusin", pin)
      document.removeEventListener("focusout", pin)
      if (virtual) props.cacheUpdated(virtual.cache)
    })
  })
  const block = (value: MarkdownBlock, index: () => number) => (
    <MarkdownDocumentBlock
      block={value}
      index={index}
      source={value.codeID ? props.document.codes[value.codeID] : undefined}
      enhance={props.enhance}
    />
  )
  return scroller ? (
    <Virtualizer
      ref={(value) => {
        if (value) virtual = value
      }}
      data={props.document.blocks}
      scrollRef={scroller}
      startMargin={margin()}
      overscan={4}
      keepMounted={kept()}
      cache={props.cache}
    >
      {block}
    </Virtualizer>
  ) : (
    <WindowVirtualizer
      ref={(value) => {
        if (value) virtual = value
      }}
      data={props.document.blocks}
      overscan={4}
      cache={props.cache}
    >
      {block}
    </WindowVirtualizer>
  )
}

function MarkdownDocumentBlock(props: {
  block: MarkdownBlock
  index(): number
  source?: string
  enhance(root: HTMLDivElement, source?: string): () => void
}) {
  let root!: HTMLDivElement
  onMount(() => {
    root.innerHTML = sanitizeHtml(props.block.html)
    onCleanup(props.enhance(root, props.source))
  })
  return <div data-markdown-block={props.index()} ref={root} style={{ display: "flow-root" }} />
}
