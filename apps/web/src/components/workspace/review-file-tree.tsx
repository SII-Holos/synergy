import { createMemo, createSignal, For, Show } from "solid-js"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { FileIcon } from "@ericsanchezok/synergy-ui/file-icon"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { reviewFileKey } from "@ericsanchezok/synergy-ui/session-review"
import { DiffChanges } from "@ericsanchezok/synergy-ui/diff-changes"
import type { ReviewRow } from "./review-data"

interface Node {
  name: string
  path: string
  children: Map<string, Node>
  row?: ReviewRow
}
export function ReviewFileTree(props: {
  rows: ReviewRow[]
  selected?: string
  select: (id: string) => void
  label: string
  viewed: (id: string) => boolean
}) {
  const nodes = createMemo(() => {
    const root: Node = { name: "", path: "", children: new Map() }
    for (const row of props.rows) {
      let parent = root
      for (const segment of row.file.split("/")) {
        const path = parent.path ? `${parent.path}/${segment}` : segment
        let node = parent.children.get(segment)
        if (!node) {
          node = { name: segment, path, children: new Map() }
          parent.children.set(segment, node)
        }
        parent = node
      }
      if (parent.row)
        parent.children.set(reviewFileKey(row), {
          name: row.workspace?.root ?? row.legacyRoot ?? row.file,
          path: reviewFileKey(row),
          children: new Map(),
          row,
        })
      else parent.row = row
    }
    return [...root.children.values()]
  })
  return (
    <ul
      class="review-file-tree"
      role="tree"
      aria-label={props.label}
      onKeyDown={(event) => {
        if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return
        const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button")].filter(
          (button) => button.getClientRects().length,
        )
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
        const next =
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? buttons.length - 1
              : Math.max(0, Math.min(buttons.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)))
        event.preventDefault()
        buttons[next]?.focus()
      }}
    >
      <For each={nodes()}>{(node) => <TreeNode {...props} node={node} depth={0} />}</For>
    </ul>
  )
}
function TreeNode(props: {
  node: Node
  depth: number
  selected?: string
  select: (id: string) => void
  viewed: (id: string) => boolean
}) {
  const [open, setOpen] = createSignal(true)
  const row = () => props.node.row
  const id = () => (row() ? reviewFileKey(row()!) : undefined)
  return (
    <li role="none">
      <button
        type="button"
        role="treeitem"
        aria-expanded={props.node.children.size ? open() : undefined}
        aria-selected={id() ? props.selected === id() : undefined}
        title={row()?.file ?? props.node.path}
        style={{ "padding-inline-start": `${8 + props.depth * 12}px` }}
        data-selected={props.selected === id()}
        data-viewed={id() ? props.viewed(id()!) : false}
        onClick={() => (id() ? props.select(id()!) : setOpen(!open()))}
        onKeyDown={(event) => {
          if (props.node.children.size && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
            event.preventDefault()
            setOpen(event.key === "ArrowRight")
          }
        }}
      >
        <Show
          when={row()}
          fallback={<Icon name={getSemanticIcon(open() ? "navigation.collapse" : "navigation.expand")} size="small" />}
        >
          <FileIcon node={{ path: props.node.path, type: "file" }} />
        </Show>
        <span>{props.node.name}</span>
        <Show when={row()}>{(value) => <DiffChanges changes={value()} />}</Show>
      </button>
      <Show when={open() && props.node.children.size}>
        <ul role="group">
          <For each={[...props.node.children.values()]}>
            {(node) => <TreeNode {...props} node={node} depth={props.depth + 1} />}
          </For>
        </ul>
      </Show>
    </li>
  )
}
