import { createEffect, createMemo, createSignal, onCleanup, Show } from "solid-js"
import { createMediaQuery } from "@solid-primitives/media"
import { VList, type VListHandle } from "virtua/solid"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { FileIcon } from "@ericsanchezok/synergy-ui/file-icon"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { reviewFileKey } from "@ericsanchezok/synergy-ui/session-review"
import { DiffChanges } from "@ericsanchezok/synergy-ui/diff-changes"
import type { ReviewRow } from "./review-data"

interface Node {
  name: string
  key: string
  path: string
  children: Map<string, Node>
  row?: ReviewRow
}
interface Entry {
  node: Node
  depth: number
  parent?: string
  position: number
  size: number
}
// Provenance: https://github.com/inokawa/virtua (VList, version 0.42.3).
// Local adaptation: retain roving focus while hidden measurement rows settle into the visible range.
export function ReviewFileTree(props: {
  rows: ReviewRow[]
  selected?: string
  select: (id: string) => void
  label: string
  viewed: (id: string) => boolean
  filtering?: boolean
}) {
  const [active, setActive] = createSignal<string>()
  const [focused, setFocused] = createSignal<string>()
  const [pendingFocus, setPendingFocus] = createSignal<string>()
  const [closed, setClosed] = createSignal(new Set<string>())
  const touch = createMediaQuery("(hover: none), (pointer: coarse)")
  let list: VListHandle | undefined
  let element: HTMLElement | undefined
  const isOpen = (key: string) => props.filtering || !closed().has(key)
  const toggle = (key: string, open: boolean) => {
    setActive(key)
    setClosed((previous) => {
      const next = new Set(previous)
      if (open) next.delete(key)
      else next.add(key)
      return next
    })
  }
  const nodes = createMemo(() => {
    const root: Node = { name: "", key: "", path: "", children: new Map() }
    const binding = (row: ReviewRow) => JSON.stringify([row.workspace?.id, row.workspace?.generation, row.legacyRoot])
    const grouped = new Set(props.rows.map(binding)).size > 1
    for (const row of props.rows) {
      let parent = root
      const namespace = binding(row)
      if (grouped) {
        let group = root.children.get(namespace)
        if (!group) {
          const path = row.workspace?.root ?? row.legacyRoot ?? ""
          group = { name: path, key: namespace, path, children: new Map() }
          root.children.set(namespace, group)
        }
        parent = group
      }
      const segments = row.file.split("/")
      for (const [index, segment] of segments.entries()) {
        const path = segments.slice(0, index + 1).join("/")
        const leaf = index === segments.length - 1
        const key = leaf ? reviewFileKey(row) : JSON.stringify([namespace, path])
        let node = parent.children.get(key)
        if (!node) {
          node = { name: segment, key, path, children: new Map(), row: leaf ? row : undefined }
          parent.children.set(key, node)
        }
        parent = node
      }
    }
    return [...root.children.values()]
  })
  const entries = createMemo(() => {
    const result: Entry[] = []
    const collect = (siblings: Node[], depth: number, parent?: string) => {
      siblings.forEach((node, index) => {
        result.push({ node, depth, parent, position: index + 1, size: siblings.length })
        if (isOpen(node.key)) collect([...node.children.values()], depth + 1, node.key)
      })
    }
    collect(nodes(), 0)
    return result
  })
  const indices = createMemo(() => new Map(entries().map((entry, index) => [entry.node.key, index])))
  createEffect(() => {
    if (!active() || !indices().has(active()!)) setActive(entries()[0]?.node.key)
    if (pendingFocus() && !indices().has(pendingFocus()!)) setPendingFocus(undefined)
  })
  const focus = (index: number) => {
    const entry = entries()[index]
    if (!entry) return
    setActive(entry.node.key)
    setPendingFocus(entry.node.key)
    list?.scrollToIndex(index, { align: "nearest" })
  }
  return (
    <VList
      ref={(value) => {
        list = value
      }}
      class="review-file-tree"
      role="tree"
      aria-label={props.label}
      data={entries()}
      itemSize={touch() ? 44 : 32}
      overscan={4}
      keepMounted={[indices().get(active() ?? "") ?? 0, indices().get(focused() ?? "") ?? 0]}
      style={{ height: `min(${entries().length * (touch() ? 44 : 32)}px, 50dvh)` }}
      onScrollEnd={() => {
        if (pendingFocus()) element?.querySelector<HTMLButtonElement>('[tabindex="0"]')?.focus({ preventScroll: true })
      }}
      onKeyDown={(event) => {
        if (!["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return
        const index = indices().get(active() ?? "")
        const entry = index !== undefined ? entries()[index] : undefined
        if (!entry) return
        element = event.currentTarget
        event.preventDefault()
        if (event.key === "ArrowRight" && entry.node.children.size) {
          if (!isOpen(entry.node.key)) toggle(entry.node.key, true)
          else focus(index! + 1)
        } else if (event.key === "ArrowLeft") {
          if (entry.node.children.size && isOpen(entry.node.key)) toggle(entry.node.key, false)
          else if (entry.parent) focus(indices().get(entry.parent)!)
        } else if (event.key !== "ArrowRight") {
          focus(
            event.key === "Home"
              ? 0
              : event.key === "End"
                ? entries().length - 1
                : Math.max(0, Math.min(entries().length - 1, index! + (event.key === "ArrowDown" ? 1 : -1))),
          )
        }
      }}
    >
      {(entry) => (
        <TreeRow
          {...props}
          entry={entry}
          active={active}
          pendingFocus={pendingFocus}
          focus={(key) => {
            setActive(key)
            setFocused(key)
            setPendingFocus(undefined)
          }}
          cancelFocus={() => setPendingFocus(undefined)}
          isOpen={isOpen}
          toggle={toggle}
        />
      )}
    </VList>
  )
}
function TreeRow(props: {
  entry: Entry
  selected?: string
  select: (id: string) => void
  viewed: (id: string) => boolean
  active: () => string | undefined
  pendingFocus: () => string | undefined
  focus: (key: string) => void
  cancelFocus: () => void
  isOpen: (key: string) => boolean | undefined
  toggle: (key: string, open: boolean) => void
}) {
  let button!: HTMLButtonElement
  const row = () => props.entry.node.row
  const id = () => (row() ? reviewFileKey(row()!) : undefined)
  const open = () => props.isOpen(props.entry.node.key)
  createEffect(() => {
    if (props.pendingFocus() !== props.entry.node.key) return
    const frame = requestAnimationFrame(() => button.focus({ preventScroll: true }))
    onCleanup(() => cancelAnimationFrame(frame))
  })
  return (
    <button
      ref={button}
      type="button"
      role="treeitem"
      tabIndex={props.active() === props.entry.node.key ? 0 : -1}
      aria-level={props.entry.depth + 1}
      aria-posinset={props.entry.position}
      aria-setsize={props.entry.size}
      aria-expanded={props.entry.node.children.size ? Boolean(open()) : undefined}
      aria-selected={id() ? props.selected === id() : undefined}
      title={row()?.file ?? props.entry.node.path}
      style={{ "padding-inline-start": `${8 + props.entry.depth * 12}px` }}
      data-selected={Boolean(id() && props.selected === id())}
      data-viewed={id() ? props.viewed(id()!) : false}
      onFocus={() => props.focus(props.entry.node.key)}
      onBlur={(event) => {
        if (
          event.relatedTarget instanceof HTMLElement &&
          !event.currentTarget.closest('[role="tree"]')?.contains(event.relatedTarget)
        )
          props.cancelFocus()
      }}
      onClick={() => (id() ? props.select(id()!) : props.toggle(props.entry.node.key, !open()))}
    >
      <Show
        when={row()}
        fallback={<Icon name={getSemanticIcon(open() ? "navigation.collapse" : "navigation.expand")} size="small" />}
      >
        <FileIcon node={{ path: props.entry.node.path, type: "file" }} />
      </Show>
      <span>{props.entry.node.name}</span>
      <Show when={row()}>{(value) => <DiffChanges changes={value()} />}</Show>
    </button>
  )
}
