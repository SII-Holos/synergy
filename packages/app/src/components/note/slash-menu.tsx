import { Extension, type Editor } from "@tiptap/core"
import { PluginKey } from "@tiptap/pm/state"
import Suggestion, { type SuggestionProps, type SuggestionKeyDownProps } from "@tiptap/suggestion"
import { createSignal, For, Show, type Accessor } from "solid-js"
import { render as solidRender } from "solid-js/web"
import { Icon, type IconName } from "@ericsanchezok/synergy-ui/icon"

interface CommandItem {
  id: string
  title: string
  icon: string
  iconName?: IconName
  section: "grid" | "list"
  category?: string
  command: (editor: Editor) => void
}

interface SlashCommandsOptions {
  onUploadFile?: (file: File) => Promise<string>
}

function buildSlashCommands(options?: SlashCommandsOptions): CommandItem[] {
  return [
    {
      id: "h1",
      title: "H1",
      icon: "H1",
      section: "grid",
      command: (editor) => editor.chain().focus().setHeading({ level: 1 }).run(),
    },
    {
      id: "h2",
      title: "H2",
      icon: "H2",
      section: "grid",
      command: (editor) => editor.chain().focus().setHeading({ level: 2 }).run(),
    },
    {
      id: "h3",
      title: "H3",
      icon: "H3",
      section: "grid",
      command: (editor) => editor.chain().focus().setHeading({ level: 3 }).run(),
    },
    {
      id: "bullet",
      title: "List",
      icon: "•—",
      iconName: "list",
      section: "grid",
      command: (editor) => editor.chain().focus().toggleBulletList().run(),
    },
    {
      id: "ordered",
      title: "Num",
      icon: "1.",
      section: "grid",
      command: (editor) => editor.chain().focus().toggleOrderedList().run(),
    },
    {
      id: "task",
      title: "Task",
      icon: "☑",
      iconName: "list-checks",
      section: "grid",
      command: (editor) => editor.chain().focus().toggleTaskList().run(),
    },
    {
      id: "code",
      title: "Code",
      icon: "{ }",
      iconName: "code",
      section: "grid",
      command: (editor) => editor.chain().focus().setCodeBlock().run(),
    },
    {
      id: "quote",
      title: "Quote",
      icon: "❝",
      iconName: "quote",
      section: "grid",
      command: (editor) => editor.chain().focus().setBlockquote().run(),
    },
    {
      id: "hr",
      title: "Line",
      icon: "—",
      section: "grid",
      command: (editor) => editor.chain().focus().setHorizontalRule().run(),
    },
    {
      id: "image",
      title: "Image",
      icon: "🖼",
      iconName: "image",
      section: "list",
      category: "Insert",
      command: (editor) => {
        const input = document.createElement("input")
        input.type = "file"
        input.accept = "image/*"
        input.onchange = async () => {
          const file = input.files?.[0]
          if (!file || !options?.onUploadFile) return
          try {
            const url = await options.onUploadFile(file)
            editor.chain().focus().setImage({ src: url }).run()
          } catch (e) {
            console.error("Failed to upload image:", e)
          }
        }
        input.click()
      },
    },
    {
      id: "video",
      title: "Video",
      icon: "▶",
      iconName: "square-play",
      section: "list",
      category: "Insert",
      command: (editor) => {
        const input = document.createElement("input")
        input.type = "file"
        input.accept = "video/*"
        input.onchange = async () => {
          const file = input.files?.[0]
          if (!file || !options?.onUploadFile) return
          try {
            const url = await options.onUploadFile(file)
            editor
              .chain()
              .focus()
              .insertContent({ type: "video", attrs: { src: url, controls: true } })
              .run()
          } catch (e) {
            console.error("Failed to upload video:", e)
          }
        }
        input.click()
      },
    },
    {
      id: "table",
      title: "Table",
      icon: "⊞",
      iconName: "table",
      section: "list",
      category: "Insert",
      command: (editor) => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
    },
    {
      id: "math",
      title: "Math",
      icon: "∑",
      iconName: "sigma",
      section: "list",
      category: "Insert",
      command: (editor) =>
        editor
          .chain()
          .focus()
          .insertContent({ type: "math_display", attrs: { content: "" } })
          .run(),
    },
    {
      id: "mermaid",
      title: "Diagram",
      icon: "◇",
      iconName: "diamond",
      section: "list",
      category: "Insert",
      command: (editor) =>
        editor
          .chain()
          .focus()
          .insertContent({ type: "mermaid", attrs: { content: "graph TD\n  A --> B" } })
          .run(),
    },
  ]
}

const SlashCommandsKey = new PluginKey("slashCommands")

function ItemIcon(props: { item: CommandItem; class?: string }) {
  return (
    <Show when={props.item.iconName} fallback={<span class={props.class}>{props.item.icon}</span>}>
      <Icon name={props.item.iconName!} size="small" class={props.class} />
    </Show>
  )
}

function SlashDropdown(props: {
  items: Accessor<CommandItem[]>
  query: Accessor<string>
  selectedIndex: Accessor<number>
  position: Accessor<{ top: number; left: number }>
  onSelect: (item: CommandItem) => void
  onHover: (index: number) => void
}) {
  let panelRef: HTMLDivElement | undefined

  const scrollSelectedIntoView = (idx: number) => {
    if (!panelRef) return
    const el = panelRef.querySelector(`[data-idx="${idx}"]`) as HTMLElement | null
    el?.scrollIntoView({ block: "nearest" })
  }

  function gridOf(items: CommandItem[]) {
    return items.filter((i) => i.section === "grid")
  }
  function listOf(items: CommandItem[]) {
    return items.filter((i) => i.section === "list")
  }
  function flatOf(items: CommandItem[]) {
    return [...gridOf(items), ...listOf(items)]
  }
  function catsOf(items: CommandItem[]) {
    const cats: string[] = []
    for (const item of listOf(items)) {
      if (item.category && !cats.includes(item.category)) cats.push(item.category)
    }
    return cats
  }

  function SelectedTracker(itemProps: { idx: number }) {
    const isSelected = () => {
      const selected = itemProps.idx === props.selectedIndex()
      if (selected) scrollSelectedIntoView(itemProps.idx)
      return selected
    }
    return { isSelected }
  }

  function ListRow(rowProps: { item: CommandItem; idx: number }) {
    const { isSelected } = SelectedTracker({ idx: rowProps.idx })
    return (
      <button
        type="button"
        data-idx={rowProps.idx}
        classList={{
          "w-full flex items-center gap-2.5 px-2 py-1.5 rounded-lg text-left transition-colors": true,
          "bg-surface-interactive-base/15": isSelected(),
          "hover:bg-surface-raised-base-hover": !isSelected(),
        }}
        onMouseDown={(e) => {
          e.preventDefault()
          props.onSelect(rowProps.item)
        }}
        onMouseEnter={() => props.onHover(rowProps.idx)}
      >
        <span class="size-6 flex items-center justify-center rounded-md bg-surface-inset-base text-text-weak shrink-0">
          <ItemIcon item={rowProps.item} class="text-12-medium" />
        </span>
        <span class="text-13-medium text-text-strong">{rowProps.item.title}</span>
      </button>
    )
  }

  return (
    <Show when={props.items().length > 0}>
      {(() => {
        const all = props.items()
        const isSearching = props.query().length > 0
        const grid = gridOf(all)
        const list = listOf(all)
        const flat = isSearching ? all : flatOf(all)
        const cats = catsOf(all)

        return (
          <div
            ref={panelRef}
            class="w-56 max-h-80 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden rounded-xl border border-border-base/40 bg-surface-raised-stronger-non-alpha shadow-lg p-1.5"
            style={{
              position: "fixed",
              top: `${props.position().top}px`,
              left: `${props.position().left}px`,
              "z-index": "9999",
            }}
          >
            <Show when={isSearching}>
              <For each={all}>
                {(item) => {
                  const idx = flat.indexOf(item)
                  return <ListRow item={item} idx={idx} />
                }}
              </For>
            </Show>

            <Show when={!isSearching}>
              <Show when={grid.length > 0}>
                <div class="grid grid-cols-5 gap-0.5 pb-1.5">
                  <For each={grid}>
                    {(item) => {
                      const idx = flat.indexOf(item)
                      const { isSelected } = SelectedTracker({ idx })
                      return (
                        <button
                          type="button"
                          data-idx={idx}
                          classList={{
                            "flex flex-col items-center justify-center gap-0.5 rounded-lg py-1.5 transition-colors": true,
                            "bg-surface-interactive-base/15 text-text-interactive-base": isSelected(),
                            "text-text-weak hover:bg-surface-raised-base-hover hover:text-text-strong": !isSelected(),
                          }}
                          onMouseDown={(e) => {
                            e.preventDefault()
                            props.onSelect(item)
                          }}
                          onMouseEnter={() => props.onHover(idx)}
                        >
                          <span class="text-12-medium leading-none">{item.icon}</span>
                          <span class="text-10-regular leading-none mt-0.5">{item.title}</span>
                        </button>
                      )
                    }}
                  </For>
                </div>
              </Show>

              <Show when={list.length > 0}>
                <Show when={grid.length > 0}>
                  <div class="border-t border-border-weak-base/40 my-1" />
                </Show>
                <For each={cats}>
                  {(cat) => {
                    const catItems = list.filter((i) => i.category === cat)
                    return (
                      <Show when={catItems.length > 0}>
                        <div class="px-1.5 pt-1.5 pb-0.5 text-10-regular text-text-weak uppercase tracking-wider">
                          {cat}
                        </div>
                        <For each={catItems}>
                          {(item) => {
                            const idx = flat.indexOf(item)
                            return <ListRow item={item} idx={idx} />
                          }}
                        </For>
                      </Show>
                    )
                  }}
                </For>
              </Show>
            </Show>
          </div>
        )
      })()}
    </Show>
  )
}

function createSlashMenuRenderer() {
  let container: HTMLElement | null = null
  let dispose: (() => void) | undefined

  const [items, setItems] = createSignal<CommandItem[]>([])
  const [selectedIndex, setSelectedIndex] = createSignal(0)
  const [position, setPosition] = createSignal({ top: 0, left: 0 })
  const [query, setQuery] = createSignal("")
  let commandRef: ((item: CommandItem) => void) | undefined

  function updatePosition(props: SuggestionProps<CommandItem, CommandItem>) {
    const rect = props.clientRect?.()
    if (!rect) return
    setPosition({ top: rect.bottom + 4, left: rect.left })
  }

  return {
    onStart(props: SuggestionProps<CommandItem, CommandItem>) {
      container = document.createElement("div")
      container.style.position = "fixed"
      container.style.zIndex = "9999"
      document.body.appendChild(container)

      setItems(props.items)
      setSelectedIndex(0)
      setQuery(props.query)
      commandRef = (item) => props.command(item)
      updatePosition(props)

      dispose = solidRender(
        () => (
          <SlashDropdown
            items={items}
            query={query}
            selectedIndex={selectedIndex}
            position={position}
            onSelect={(item) => commandRef?.(item)}
            onHover={(index) => setSelectedIndex(index)}
          />
        ),
        container,
      )
    },

    onUpdate(props: SuggestionProps<CommandItem, CommandItem>) {
      setItems(props.items)
      setSelectedIndex(0)
      setQuery(props.query)
      commandRef = (item) => props.command(item)
      updatePosition(props)
    },

    onExit() {
      dispose?.()
      container?.remove()
      container = null
    },

    onKeyDown({ event }: SuggestionKeyDownProps) {
      if (event.key === "ArrowDown") {
        setSelectedIndex((i) => (i + 1) % Math.max(items().length, 1))
        return true
      }
      if (event.key === "ArrowUp") {
        setSelectedIndex((i) => (i - 1 + items().length) % Math.max(items().length, 1))
        return true
      }
      if (event.key === "Enter") {
        const item = items()[selectedIndex()]
        if (item) commandRef?.(item)
        return true
      }
      if (event.key === "Escape") {
        return true
      }
      return false
    },
  }
}

export function createSlashCommands(options?: SlashCommandsOptions) {
  const commands = buildSlashCommands(options)

  return Extension.create({
    name: "slashCommands",

    addProseMirrorPlugins() {
      return [
        Suggestion<CommandItem, CommandItem>({
          editor: this.editor,
          char: "/",
          pluginKey: SlashCommandsKey,
          startOfLine: false,
          allowSpaces: false,

          items: ({ query }) => {
            if (!query) return commands
            const q = query.toLowerCase()
            return commands.filter((item) => item.title.toLowerCase().includes(q) || item.id.includes(q))
          },

          command: ({ editor, range, props }) => {
            editor.chain().focus().deleteRange(range).run()
            props.command(editor)
          },

          render: () => createSlashMenuRenderer(),
        }),
      ]
    },
  })
}
