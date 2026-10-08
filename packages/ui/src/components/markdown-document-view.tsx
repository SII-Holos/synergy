import { Virtualizer, WindowVirtualizer, type VirtualizerHandle, type WindowVirtualizerHandle } from "virtua/solid"
import { createSignal, onCleanup, onMount } from "solid-js"
import type { MarkdownBlock, MarkdownDocument } from "../context/markdown-document"
import { sanitizeHtml } from "./markdown-sanitize"
import { markdownLayoutSignature, type MarkdownStreamLayout } from "./markdown-stream-source"
import type { MarkdownLayoutCache } from "./markdown-render"
import { focusMarkdownHeading, markdownHeadings } from "./markdown-navigation"
import { markdownReadingPoint } from "./markdown-reading"
import { markdownScrollViewport } from "./markdown-scroll-viewport"
import { readSelectionElements } from "../utils/selection"

export function MarkdownDocumentView(props: {
  root: HTMLDivElement
  document: MarkdownDocument
  cache?: MarkdownLayoutCache
  initialLayout?: MarkdownStreamLayout
  cacheUpdated(cache: MarkdownLayoutCache | undefined): void
  enhance(root: HTMLDivElement, source?: string): () => void
}) {
  const scroller = markdownScrollViewport(props.root)
  const signature = markdownLayoutSignature(props.root)
  const matches = (layout: MarkdownLayoutCache | MarkdownStreamLayout | undefined) =>
    layout?.width === signature.width && layout.font === signature.font
  const initial = matches(props.initialLayout) ? props.initialLayout : undefined
  const cache = matches(props.cache) ? props.cache!.measurements : undefined
  let reusable = true
  const [margin, setMargin] = createSignal(0)
  const [kept, setKept] = createSignal<number[]>([])
  let virtual: VirtualizerHandle | WindowVirtualizerHandle | undefined
  let anchorRestored = false
  let disposed = false
  let headingTarget: { block: number; heading: number } | undefined
  const reveal = (root: HTMLElement, block: number) => {
    if (headingTarget?.block !== block) return
    const element = root.querySelectorAll<HTMLElement>("h1,h2,h3,h4,h5,h6")[headingTarget.heading]
    if (!element) return
    headingTarget = undefined
    queueMicrotask(() => {
      if (!disposed && element.isConnected) focusMarkdownHeading(element)
    })
  }
  const navigate = (event: Event) => {
    const id = (event as CustomEvent<string>).detail
    const counts = new Map<string, number>()
    const template = document.createElement("template")
    for (let index = 0; index < props.document.blocks.length; index++) {
      const html = props.document.blocks[index].html
      if (!/<h[1-6]\b/i.test(html)) continue
      template.innerHTML = html
      const heading = markdownHeadings(template.content, counts).findIndex((item) => item.id === id)
      if (heading < 0) continue
      event.preventDefault()
      headingTarget = { block: index, heading }
      virtual?.scrollToIndex(index, { align: "start" })
      const mounted = props.root.querySelector<HTMLElement>(`[data-markdown-block="${index}"]`)
      if (mounted) reveal(mounted, index)
      return
    }
  }
  onCleanup(() => {
    disposed = true
  })
  const restoreAnchor = (root: HTMLElement, index: number) => {
    const anchor = initial?.anchor
    if (!anchor || anchor.index !== index || anchorRestored) return
    anchorRestored = true
    queueMicrotask(() => {
      if (disposed || !virtual) return
      const point = markdownReadingPoint(root, props.document, anchor.source)
      if (point === undefined) return
      virtual.restoreToIndex(index, point - root.getBoundingClientRect().top - anchor.offset)
    })
  }
  const pin = (event?: Event) => {
    const selected = new Set<number>()
    const add = (node: Node | null) => {
      const element = node instanceof Element ? node : node?.parentElement
      const block = element?.closest<HTMLElement>("[data-markdown-block]")
      if (block && props.root.contains(block)) selected.add(Number(block.dataset.markdownBlock))
    }
    const focus = event?.type === "focusout" ? (event as FocusEvent).relatedTarget : document.activeElement
    add(focus instanceof Node ? focus : null)
    for (const block of readSelectionElements(props.root, "[data-markdown-block]")) add(block)
    setKept((previous) =>
      previous.length === selected.size && previous.every((index) => selected.has(index)) ? previous : [...selected],
    )
  }
  onMount(() => {
    const measure = () => {
      const current = markdownLayoutSignature(props.root)
      if (current.width !== signature.width || current.font !== signature.font) reusable = false
      if (scroller)
        setMargin(props.root.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop)
    }
    const observer = new ResizeObserver(measure)
    observer.observe(props.root)
    if (props.root.parentElement) observer.observe(props.root.parentElement)
    if (scroller?.firstElementChild) observer.observe(scroller.firstElementChild)
    measure()
    props.root.addEventListener("markdown-reveal-heading", navigate)
    scroller?.addEventListener("scroll", measure, { passive: true })
    props.root.addEventListener("load", measure, true)
    document.addEventListener("selectionchange", pin)
    document.addEventListener("focusin", pin)
    document.addEventListener("focusout", pin)
    onCleanup(() => {
      observer.disconnect()
      props.root.removeEventListener("markdown-reveal-heading", navigate)
      scroller?.removeEventListener("scroll", measure)
      props.root.removeEventListener("load", measure, true)
      document.removeEventListener("selectionchange", pin)
      document.removeEventListener("focusin", pin)
      document.removeEventListener("focusout", pin)
      measure()
      if (virtual) props.cacheUpdated(reusable ? { ...signature, measurements: virtual.cache } : undefined)
    })
  })
  const block = (value: MarkdownBlock, index: () => number) => (
    <MarkdownDocumentBlock
      block={value}
      index={index}
      source={value.codeID ? props.document.codes[value.codeID] : undefined}
      enhance={props.enhance}
      ready={(root) => {
        restoreAnchor(root, index())
        reveal(root, index())
      }}
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
      cache={cache}
      initialSizes={initial?.sizes}
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
      cache={cache}
      initialSizes={initial?.sizes}
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
  ready(root: HTMLDivElement): void
}) {
  let root!: HTMLDivElement
  onMount(() => {
    root.innerHTML = sanitizeHtml(props.block.html)
    onCleanup(props.enhance(root, props.source))
    props.ready(root)
  })
  return <div data-markdown-block={props.index()} ref={root} style={{ display: "flow-root" }} />
}
