import { describe, expect, test } from "bun:test"
import {
  applyMarkdownTerminalCrossfade,
  MARKDOWN_TERMINAL_CROSSFADE_MAX_CHARS,
  MARKDOWN_TERMINAL_CROSSFADE_MS,
  markdownTerminalTransitionMode,
} from "../src/components/markdown-terminal-transition"

type NodeLike = {
  dataset: Record<string, string>
  attributes: Record<string, string>
  childNodes: NodeLike[]
  html: string
  text: string
  inert: boolean
  layoutReads: number
  append: (...nodes: NodeLike[]) => void
  replaceChildren: (...nodes: NodeLike[]) => void
  querySelector: (selector: string) => NodeLike | null
  getAttribute: (name: string) => string | null
  setAttribute: (name: string, value: string) => void
  getBoundingClientRect: () => { width: number; height: number }
  get innerHTML(): string
  set innerHTML(value: string)
  get textContent(): string
  set textContent(value: string)
}

function createNode(html = "", text = html.replaceAll(/<[^>]+>/g, "")): NodeLike {
  const dataset: Record<string, string> = {}
  const attributes: Record<string, string> = {}
  const node: NodeLike = {
    dataset,
    attributes,
    childNodes: [],
    html,
    text,
    inert: false,
    layoutReads: 0,
    get innerHTML() {
      return this.html
    },
    set innerHTML(value: string) {
      this.html = value
      this.text = value.replaceAll(/<[^>]+>/g, "")
      // Represent the markup as a single leaf child without recursive parsing.
      this.childNodes = value
        ? [
            {
              ...createLeaf(value, this.text),
            },
          ]
        : []
    },
    get textContent() {
      if (this.childNodes.length > 0) return this.childNodes.map((child) => child.textContent).join("")
      return this.text
    },
    set textContent(value: string) {
      this.text = value
      this.html = value
      this.childNodes = []
    },
    append(...nodes: NodeLike[]) {
      this.childNodes.push(...nodes)
    },
    replaceChildren(...nodes: NodeLike[]) {
      this.childNodes = [...nodes]
      this.html = nodes.map((child) => child.html || child.text).join("")
      this.text = nodes.map((child) => child.text).join("")
    },
    querySelector(selector: string) {
      const match = selector.match(/\[data-slot="([^"]+)"\]/)
      if (!match) return null
      const slot = match[1]!
      const visit = (current: NodeLike): NodeLike | null => {
        if (current.dataset.slot === slot) return current
        for (const child of current.childNodes) {
          const found = visit(child)
          if (found) return found
        }
        return null
      }
      return visit(this)
    },
    setAttribute(name: string, value: string) {
      this.attributes[name] = value
    },
    getAttribute(name: string) {
      if (name === "data-active") return this.dataset.active ?? null
      if (name === "data-slot") return this.dataset.slot ?? null
      return this.attributes[name] ?? null
    },
    getBoundingClientRect() {
      this.layoutReads += 1
      return { width: 1, height: 1 }
    },
  }
  return node
}

function createLeaf(html: string, text: string): NodeLike {
  const dataset: Record<string, string> = {}
  const attributes: Record<string, string> = {}
  return {
    dataset,
    attributes,
    childNodes: [],
    html,
    text,
    inert: false,
    layoutReads: 0,
    get innerHTML() {
      return this.html
    },
    set innerHTML(value: string) {
      this.html = value
      this.text = value.replaceAll(/<[^>]+>/g, "")
    },
    get textContent() {
      return this.text
    },
    set textContent(value: string) {
      this.text = value
      this.html = value
    },
    append() {},
    replaceChildren(...nodes: NodeLike[]) {
      this.childNodes = [...nodes]
      this.html = nodes.map((child) => child.html || child.text).join("")
      this.text = nodes.map((child) => child.text).join("")
    },
    querySelector() {
      return null
    },
    setAttribute(name: string, value: string) {
      this.attributes[name] = value
    },
    getAttribute(name: string) {
      return this.attributes[name] ?? null
    },
    getBoundingClientRect() {
      this.layoutReads += 1
      return { width: 1, height: 1 }
    },
  }
}

;(globalThis as any).document = {
  createElement() {
    return createNode()
  },
}

function createContainer(markup: string, text: string) {
  const container = createNode()
  const child = createLeaf(markup, text)
  container.childNodes = [child]
  container.html = markup
  container.text = text
  return container as unknown as HTMLElement
}

function countSlot(node: NodeLike, slot: string): number {
  let count = node.dataset.slot === slot ? 1 : 0
  for (const child of node.childNodes) count += countSlot(child, slot)
  return count
}

describe("markdownTerminalTransitionMode", () => {
  test("uses crossfade only after a live stream with motion allowed", () => {
    expect(
      markdownTerminalTransitionMode({
        hadStreamContent: true,
        markdownLength: 120,
        prefersReducedMotion: false,
      }),
    ).toBe("crossfade")
  })

  test("stays instant for historical renders, reduced motion, and huge replies", () => {
    expect(
      markdownTerminalTransitionMode({
        hadStreamContent: false,
        markdownLength: 120,
        prefersReducedMotion: false,
      }),
    ).toBe("instant")
    expect(
      markdownTerminalTransitionMode({
        hadStreamContent: true,
        markdownLength: 120,
        prefersReducedMotion: true,
      }),
    ).toBe("instant")
    expect(
      markdownTerminalTransitionMode({
        hadStreamContent: true,
        markdownLength: MARKDOWN_TERMINAL_CROSSFADE_MAX_CHARS + 1,
        prefersReducedMotion: false,
      }),
    ).toBe("instant")
  })
})

describe("applyMarkdownTerminalCrossfade", () => {
  test("crossfades stream DOM into terminal HTML once, then collapses to the final tree", () => {
    const container = createContainer("<p>stream partial</p>", "stream partial")
    const frames: Array<() => void> = []
    const timeouts: Array<{ callback: () => void; ms: number }> = []
    const enhancedRoots: HTMLElement[] = []
    let enhanceLive = 0

    const cleanup = applyMarkdownTerminalCrossfade({
      container,
      html: "<p><strong>final</strong></p>",
      durationMs: MARKDOWN_TERMINAL_CROSSFADE_MS,
      enhance: (root) => {
        enhancedRoots.push(root)
        enhanceLive += 1
        return () => {
          enhanceLive -= 1
        }
      },
      nextFrame: (callback) => {
        frames.push(callback)
        return frames.length
      },
      cancelFrame: () => {},
      schedule: (callback, ms) => {
        timeouts.push({ callback, ms })
        return timeouts.length
      },
      cancel: () => {},
      prefersReducedMotion: false,
      markdownLength: 32,
      hadStreamContent: true,
    })

    const stage = container.querySelector('[data-slot="markdown-terminal-crossfade"]')
    expect(stage).toBeTruthy()
    expect(container.querySelector('[data-slot="markdown-terminal-from"]')?.textContent).toBe("stream partial")
    expect(container.querySelector('[data-slot="markdown-terminal-to"]')?.innerHTML).toBe(
      "<p><strong>final</strong></p>",
    )
    const previous = container.querySelector<HTMLElement>('[data-slot="markdown-terminal-from"]')
    expect(previous?.getAttribute("aria-hidden")).toBe("true")
    expect(previous?.inert).toBe(true)
    expect(enhanceLive).toBe(1)
    expect(enhancedRoots).toHaveLength(1)
    expect((previous as unknown as NodeLike).layoutReads).toBe(0)

    expect(frames).toHaveLength(1)
    frames[0]!()
    expect(stage?.getAttribute("data-active")).toBeNull()
    expect(frames).toHaveLength(2)
    frames[1]!()
    expect(stage?.getAttribute("data-active")).toBe("true")
    expect(timeouts).toHaveLength(1)
    expect(timeouts[0]?.ms).toBe(MARKDOWN_TERMINAL_CROSSFADE_MS)

    timeouts[0]!.callback()
    expect(container.querySelector('[data-slot="markdown-terminal-crossfade"]')).toBeNull()
    expect(container.innerHTML).toBe("<p><strong>final</strong></p>")
    expect(enhanceLive).toBe(1)
    expect(enhancedRoots).toHaveLength(1)

    cleanup()
    expect(enhanceLive).toBe(0)
  })

  test("collapses interrupted transitions instead of nesting terminal trees", () => {
    const container = createContainer("<p>stream partial</p>", "stream partial")
    let cleanup: (() => void) | undefined

    for (let update = 1; update <= 100; update++) {
      cleanup?.()
      expect(countSlot(container as unknown as NodeLike, "markdown-terminal-crossfade")).toBe(0)

      cleanup = applyMarkdownTerminalCrossfade({
        container,
        html: `<p>terminal ${update}</p>`,
        nextFrame: () => update,
        cancelFrame: () => {},
        schedule: () => update,
        cancel: () => {},
        prefersReducedMotion: false,
        markdownLength: 32,
        hadStreamContent: true,
      })

      expect(countSlot(container as unknown as NodeLike, "markdown-terminal-crossfade")).toBe(1)
    }

    cleanup?.()
    expect(countSlot(container as unknown as NodeLike, "markdown-terminal-crossfade")).toBe(0)
    expect(container.innerHTML).toBe("<p>terminal 100</p>")
  })

  test("replaces instantly when reduced motion is preferred", () => {
    const container = createContainer("<p>stream partial</p>", "stream partial")
    let enhanceLive = 0

    applyMarkdownTerminalCrossfade({
      container,
      html: "<p>final</p>",
      enhance: () => {
        enhanceLive += 1
        return () => {
          enhanceLive -= 1
        }
      },
      prefersReducedMotion: true,
      markdownLength: 16,
      hadStreamContent: true,
    })

    expect(container.innerHTML).toBe("<p>final</p>")
    expect(enhanceLive).toBe(1)
  })
})
