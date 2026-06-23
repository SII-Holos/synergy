import { createMemo, For, Show } from "solid-js"
import { Todo } from "@ericsanchezok/synergy-sdk"
import { getFilename } from "@ericsanchezok/synergy-util/path"
import { useData } from "../../../context"
import { BasicTool } from "../../basic-tool"
import { Icon } from "../../icon"
import { Checkbox } from "../../checkbox"
import { RenderHtml } from "../../render-html"
import { AttachmentList } from "../../attachment-card"
import { ToolTextOutput } from "../../tool-output-text"
import { ToolRegistry, getToolInfo, getDirectory } from "../../message-part"

ToolRegistry.register({
  name: "read",
  render(props) {
    const rangeLabel = () => {
      const offset = props.metadata?.offset ?? props.input.offset
      const limit = props.metadata?.limit ?? props.input.limit
      if (offset || limit) {
        const start = offset ?? 0
        const end = start + (limit ?? 0)
        return `L${start}–${end}`
      }
      return undefined
    }
    return (
      <BasicTool
        {...props}
        trigger={{
          icon: "glasses",
          title: "Read",
          subtitle: props.input.filePath
            ? getDirectory(props.input.filePath) + getFilename(props.input.filePath)
            : undefined,
          tags: rangeLabel() ? [{ label: rangeLabel()! }] : undefined,
        }}
      >
        <Show when={props.output}>
          {(output) => (
            <div data-component="tool-output" data-scrollable>
              <ToolTextOutput text={output()} />
            </div>
          )}
        </Show>
      </BasicTool>
    )
  },
})

ToolRegistry.register({
  name: "list",
  render(props) {
    return (
      <BasicTool
        {...props}
        trigger={{
          icon: "folder",
          title: "List",
          subtitle: props.input.path ? getDirectory(props.input.path) + getFilename(props.input.path) : undefined,
        }}
      >
        <Show when={props.output}>
          {(output) => (
            <div data-component="tool-output" data-scrollable>
              <ToolTextOutput text={output()} />
            </div>
          )}
        </Show>
      </BasicTool>
    )
  },
})

ToolRegistry.register({
  name: "session_list",
  render(props) {
    const count = () => props.metadata?.count as number | undefined
    return (
      <BasicTool
        {...props}
        trigger={{
          icon: "list",
          title: "Sessions",
          subtitle: props.input.scope || "",
          tags:
            count() != null ? [`${count()} session${count() === 1 ? "" : "s"}`].map((l) => ({ label: l })) : undefined,
        }}
      >
        <Show when={props.output}>
          {(output) => (
            <div data-component="tool-output" data-scrollable>
              <ToolTextOutput text={output()} />
            </div>
          )}
        </Show>
      </BasicTool>
    )
  },
})

ToolRegistry.register({
  name: "session_read",
  render(props) {
    return (
      <BasicTool
        {...props}
        trigger={{
          icon: "message-square",
          title: "Read Session",
          subtitle: props.input.target || "",
        }}
      >
        <Show when={props.output}>
          {(output) => (
            <div data-component="tool-output" data-scrollable>
              <ToolTextOutput text={output()} />
            </div>
          )}
        </Show>
      </BasicTool>
    )
  },
})

ToolRegistry.register({
  name: "session_search",
  render(props) {
    return (
      <BasicTool
        {...props}
        trigger={{
          icon: "quote",
          title: "Search Sessions",
          subtitle: props.input.pattern || "",
          tags: props.input.scope ? [{ label: props.input.scope }] : undefined,
        }}
      >
        <Show when={props.output}>
          {(output) => (
            <div data-component="tool-output" data-scrollable>
              <ToolTextOutput text={output()} />
            </div>
          )}
        </Show>
      </BasicTool>
    )
  },
})

ToolRegistry.register({
  name: "session_send",
  render(props) {
    return (
      <BasicTool
        {...props}
        trigger={{
          icon: "share",
          title: "Send Message",
          subtitle: props.input.target || "",
          tags: props.input.role ? [{ label: props.input.role }] : undefined,
        }}
      />
    )
  },
})

ToolRegistry.register({
  name: "session_control",
  render(props) {
    const info = createMemo(() => getToolInfo("session_control", props.input, props.metadata))
    return (
      <BasicTool
        {...props}
        trigger={{
          icon: info().icon,
          title: info().title,
          subtitle: info().subtitle || "",
          tags: props.input.action ? [{ label: props.input.action }] : undefined,
        }}
      >
        <Show when={props.output}>
          {(output) => (
            <div data-component="tool-output" data-scrollable>
              <ToolTextOutput text={output()} />
            </div>
          )}
        </Show>
      </BasicTool>
    )
  },
})

ToolRegistry.register({
  name: "profile_get",
  render(props) {
    return (
      <BasicTool
        {...props}
        trigger={{
          icon: "user",
          title: "Profile",
        }}
      >
        <Show when={props.output}>
          {(output) => (
            <div data-component="tool-output" data-scrollable>
              <ToolTextOutput text={output()} />
            </div>
          )}
        </Show>
      </BasicTool>
    )
  },
})

ToolRegistry.register({
  name: "profile_update",
  render(props) {
    return (
      <BasicTool
        {...props}
        trigger={{
          icon: "user",
          title: "Update Profile",
          subtitle: props.input.name || "",
        }}
      />
    )
  },
})

ToolRegistry.register({
  name: "grep",
  render(props) {
    return (
      <BasicTool
        {...props}
        trigger={{
          icon: "search",
          title: "Grep",
          subtitle: getDirectory(props.input.path || "/"),
          tags: [
            ...(props.input.pattern ? [{ label: "pattern=" + props.input.pattern }] : []),
            ...(props.input.include ? [{ label: "include=" + props.input.include }] : []),
          ],
        }}
      >
        <Show when={props.output}>
          {(output) => (
            <div data-component="tool-output" data-scrollable>
              <ToolTextOutput text={output()} />
            </div>
          )}
        </Show>
      </BasicTool>
    )
  },
})

ToolRegistry.register({
  name: "glob",
  render(props) {
    return (
      <BasicTool
        {...props}
        trigger={{
          icon: "search",
          title: "Glob",
          subtitle: (props.input.pattern || "") as string,
        }}
      >
        <Show when={props.output}>
          {(output) => (
            <div data-component="tool-output" data-scrollable>
              <ToolTextOutput text={output()} />
            </div>
          )}
        </Show>
      </BasicTool>
    )
  },
})

ToolRegistry.register({
  name: "webfetch",
  render(props) {
    return (
      <BasicTool
        {...props}
        countdown={props.input.timeout ?? 30}
        trigger={{
          icon: "mouse-pointer-2",
          title: "Webfetch",
          subtitle: props.input.url || "",
          tags: props.input.format ? [{ label: "format=" + props.input.format }] : undefined,
          action: (
            <div data-component="tool-action">
              <Icon name="arrow-up-right" size="small" />
            </div>
          ),
        }}
      >
        <Show when={props.output}>
          {(output) => (
            <div data-component="tool-output" data-scrollable>
              <ToolTextOutput text={output()} />
            </div>
          )}
        </Show>
      </BasicTool>
    )
  },
})

ToolRegistry.register({
  name: "bash",
  render(props) {
    const cmd = () => {
      const raw = props.input.command ?? props.metadata.command ?? ""
      if (!raw) return undefined
      return raw.length > 40 ? raw.slice(0, 37) + "…" : raw
    }
    const countdown = () => {
      if (props.input.background) return undefined
      const timeout = props.input.timeout ?? 120
      const yieldS = props.input.yieldSeconds
      return yieldS != null ? Math.min(timeout, yieldS) : timeout
    }
    return (
      <BasicTool
        {...props}
        countdown={countdown()}
        trigger={{
          icon: "terminal",
          title: "Shell",
          subtitle: props.input.description,
          tags: cmd() ? [{ label: cmd()! }] : undefined,
        }}
      >
        <div data-component="tool-output" data-scrollable>
          <ToolTextOutput
            text={`$ ${props.input.command ?? props.metadata.command ?? ""}${props.output ? "\n\n" + props.output : ""}`}
          />
        </div>
      </BasicTool>
    )
  },
})

ToolRegistry.register({
  name: "todowrite",
  render(props) {
    const firstTodo = () => {
      const todos = props.input.todos as Todo[] | undefined
      if (!todos || todos.length === 0) return undefined
      const pending = todos.find((t: Todo) => t.status !== "completed" && t.status !== "cancelled")
      const target = pending ?? todos[todos.length - 1]
      return target.content?.length > 30 ? target.content.slice(0, 27) + "…" : target.content
    }
    const ratio = () => {
      const todos = props.input.todos as Todo[] | undefined
      if (!todos || todos.length === 0) return ""
      const completed = todos.filter((t: Todo) => t.status === "completed").length
      return `${completed}/${todos.length}`
    }
    return (
      <BasicTool
        {...props}
        trigger={{
          icon: "list-checks",
          title: "To-dos",
          subtitle: firstTodo() || "",
          tags: ratio() ? [{ label: ratio() }] : undefined,
        }}
      >
        <Show when={props.input.todos?.length}>
          <div data-component="todos">
            <For each={props.input.todos}>
              {(todo: Todo) => (
                <Checkbox readOnly checked={todo.status === "completed"}>
                  <div data-slot="message-part-todo-content" data-completed={todo.status === "completed"}>
                    {todo.content}
                  </div>
                </Checkbox>
              )}
            </For>
          </div>
        </Show>
      </BasicTool>
    )
  },
})

ToolRegistry.register({
  name: "todoread",
  render(props) {
    return (
      <BasicTool
        {...props}
        trigger={{
          icon: "list-checks",
          title: "Read to-dos",
        }}
      >
        <Show when={props.output}>
          {(output) => (
            <div data-component="tool-output" data-scrollable>
              <ToolTextOutput text={output()} />
            </div>
          )}
        </Show>
      </BasicTool>
    )
  },
})

ToolRegistry.register({
  name: "question",
  render(props) {
    const count = () => props.input.questions?.length ?? 0
    const answers = () => props.metadata?.answers as string[][] | undefined
    const timedOut = () => props.metadata?.timedOut as boolean | undefined
    const countdown = () => {
      if (timedOut()) return undefined
      return (props.metadata?.timeout ?? 1800) as number
    }
    return (
      <BasicTool
        {...props}
        countdown={countdown()}
        trigger={{
          icon: "message-circle",
          title: timedOut() ? "Question Timed Out" : "Questions",
          subtitle: timedOut() ? "No response received" : `Asked ${count()} question${count() !== 1 ? "s" : ""}`,
        }}
      >
        <Show when={props.input.questions?.length}>
          <div data-component="tool-output">
            <For each={props.input.questions}>
              {(q: { question: string; header: string }, index) => {
                const answer = () => answers()?.[index()] ?? []
                return (
                  <div data-slot="question-item">
                    <div data-slot="question-header">{q.header}</div>
                    <div data-slot="question-text">{q.question}</div>
                    <Show when={answer().length > 0}>
                      <div data-slot="question-answer">→ {answer().join(", ")}</div>
                    </Show>
                  </div>
                )
              }}
            </For>
          </div>
        </Show>
      </BasicTool>
    )
  },
})

ToolRegistry.register({
  name: "websearch",
  render(props) {
    return (
      <BasicTool
        {...props}
        trigger={{
          icon: "globe",
          title: "Web Search",
          subtitle: props.input.query || "",
          tags: [
            ...(props.input.categories ? [{ label: props.input.categories }] : []),
            ...(props.input.language ? [{ label: props.input.language }] : []),
          ],
        }}
      >
        <Show when={props.output}>
          {(output) => (
            <div data-component="tool-output" data-scrollable>
              <ToolTextOutput text={output()} />
            </div>
          )}
        </Show>
      </BasicTool>
    )
  },
})

ToolRegistry.register({
  name: "look_at",
  render(props) {
    const filePaths = () => {
      const fp = props.input.file_path
      if (!fp) return []
      return Array.isArray(fp) ? fp : [fp]
    }
    const subtitle = () => {
      const paths = filePaths()
      if (paths.length === 0) return ""
      if (paths.length === 1) return getFilename(paths[0])
      if (paths.length <= 3) return paths.map(getFilename).join(", ")
      return `${paths.length} files`
    }
    const countdown = () => {
      if (props.metadata?.timedOut) return undefined
      return props.input.timeout ?? 120
    }
    return (
      <BasicTool
        {...props}
        countdown={countdown()}
        trigger={{
          icon: "eye",
          title: props.metadata?.timedOut ? "Analysis timed out" : "Look at",
          subtitle: props.input.goal || "",
          tags: subtitle() ? [{ label: subtitle() }] : undefined,
        }}
      >
        <Show when={props.output}>
          {(output) => (
            <div data-component="tool-output" data-scrollable>
              <ToolTextOutput text={output()} />
            </div>
          )}
        </Show>
      </BasicTool>
    )
  },
})

ToolRegistry.register({
  name: "scan_document",
  render(props) {
    const args = () => {
      const parts: string[] = []
      if (props.input.offset != null) parts.push(`L${props.input.offset}`)
      if (props.input.limit != null) parts.push(`limit ${props.input.limit}`)
      return parts
    }
    return (
      <BasicTool
        {...props}
        trigger={{
          icon: "scan-document",
          title: "Read Document",
          subtitle: props.input.filePath ? getFilename(props.input.filePath) : "",
          tags: (() => {
            const a = args()
            return a.length > 0 ? a.map((l) => ({ label: l })) : undefined
          })(),
        }}
      >
        <Show when={props.output}>
          {(output) => (
            <div data-component="tool-output" data-scrollable>
              <ToolTextOutput text={output()} />
            </div>
          )}
        </Show>
      </BasicTool>
    )
  },
})

ToolRegistry.register({
  name: "ast_grep",
  render(props) {
    return (
      <BasicTool
        {...props}
        trigger={{
          icon: "code",
          title: "AST Search",
          subtitle: props.input.pattern || "",
          tags: props.input.lang ? [{ label: props.input.lang }] : undefined,
        }}
      >
        <Show when={props.output}>
          {(output) => (
            <div data-component="tool-output" data-scrollable>
              <ToolTextOutput text={output()} />
            </div>
          )}
        </Show>
      </BasicTool>
    )
  },
})

ToolRegistry.register({
  name: "patch",
  render(props) {
    return (
      <BasicTool
        {...props}
        trigger={{
          icon: "text-select",
          title: "Patch",
          subtitle: props.status === "generating" ? "Generating patch…" : props.metadata.diff ? "Applied" : "",
        }}
      >
        <Show when={props.output}>
          {(output) => (
            <div data-component="tool-output" data-scrollable>
              <ToolTextOutput text={output()} />
            </div>
          )}
        </Show>
      </BasicTool>
    )
  },
})

ToolRegistry.register({
  name: "lsp",
  render(props) {
    return (
      <BasicTool
        {...props}
        trigger={{
          icon: "server",
          title: "LSP",
          subtitle: props.input.operation || "",
          tags: [
            ...(props.input.filePath ? [{ label: getFilename(props.input.filePath) }] : []),
            ...(props.input.line ? [{ label: `L${props.input.line}` }] : []),
          ],
        }}
      >
        <Show when={props.output}>
          {(output) => (
            <div data-component="tool-output" data-scrollable>
              <ToolTextOutput text={output()} />
            </div>
          )}
        </Show>
      </BasicTool>
    )
  },
})

ToolRegistry.register({
  name: "skill",
  render(props) {
    return (
      <BasicTool
        {...props}
        trigger={{
          icon: "sparkles",
          title: "Skill",
          subtitle: props.input.name + (props.input.reference ? ` (${props.input.reference})` : "") || "",
        }}
      >
        <Show when={props.output}>
          {(output) => (
            <div data-component="tool-output" data-scrollable>
              <ToolTextOutput text={output()} />
            </div>
          )}
        </Show>
      </BasicTool>
    )
  },
})

ToolRegistry.register({
  name: "arxiv_search",
  render(props) {
    return (
      <BasicTool
        {...props}
        trigger={{
          icon: "file-text",
          title: "arXiv Search",
          subtitle: props.input.query || "",
        }}
      >
        <Show when={props.output}>
          {(output) => (
            <div data-component="tool-output" data-scrollable>
              <ToolTextOutput text={output()} />
            </div>
          )}
        </Show>
      </BasicTool>
    )
  },
})

ToolRegistry.register({
  name: "arxiv_download",
  render(props) {
    return (
      <BasicTool
        {...props}
        trigger={{
          icon: "download",
          title: "arXiv Download",
          subtitle: props.input.arxivId || "",
          tags: props.input.outputPath ? [{ label: getFilename(props.input.outputPath) }] : undefined,
        }}
      >
        <Show when={props.output}>
          {(output) => (
            <div data-component="tool-output">
              <ToolTextOutput text={output()} />
            </div>
          )}
        </Show>
      </BasicTool>
    )
  },
})

ToolRegistry.register({
  name: "process",
  render(props) {
    const label = () => {
      const desc = props.metadata.description as string | undefined
      const cmd = props.metadata.command as string | undefined
      const raw = desc || cmd || ""
      if (!raw) return undefined
      return raw.length > 30 ? raw.slice(0, 27) + "…" : raw
    }
    const shortId = () => {
      const id = props.input.processId || ""
      return id.length > 12 ? id.slice(0, 9) + "…" : id
    }
    const args = () => {
      const result: string[] = []
      if (label()) result.push(label()!)
      if (props.input.processId) result.push(shortId())
      return result
    }
    const countdown = () => {
      if (props.input.action !== "poll" || !props.input.block) return undefined
      return props.input.timeout ?? 30
    }
    return (
      <BasicTool
        {...props}
        countdown={countdown()}
        trigger={{
          icon: "terminal",
          title: "Process",
          subtitle: props.input.action || "",
          tags: (() => {
            const a = args()
            return a.length > 0 ? a.map((l) => ({ label: l })) : undefined
          })(),
        }}
      >
        <Show when={props.output}>
          {(output) => (
            <div data-component="tool-output" data-scrollable>
              <ToolTextOutput text={output()} />
            </div>
          )}
        </Show>
      </BasicTool>
    )
  },
})

ToolRegistry.register({
  name: "task_list",
  render(props) {
    const count = () => props.metadata.count as number | undefined
    return (
      <BasicTool
        {...props}
        trigger={{
          icon: "list-todo",
          title: "Task List",
          subtitle: "Visible background tasks",
          tags: count() != null ? [{ label: `${count()} task${count() === 1 ? "" : "s"}` }] : undefined,
        }}
      >
        <Show when={props.output}>
          {(output) => (
            <div data-component="tool-output" data-scrollable>
              <ToolTextOutput text={output()} />
            </div>
          )}
        </Show>
      </BasicTool>
    )
  },
})

ToolRegistry.register({
  name: "task_output",
  render(props) {
    const description = () => props.metadata.description as string | undefined
    const shortId = () => {
      const id = props.input.task_id || ""
      return id.length > 12 ? id.slice(0, 9) + "…" : id
    }
    const countdown = () => {
      if (!props.input.block) return undefined
      return props.input.timeout ?? 60
    }
    return (
      <BasicTool
        {...props}
        countdown={countdown()}
        trigger={{
          icon: "list-todo",
          title: "Task Output",
          subtitle: description() || shortId(),
          tags: description() ? [{ label: shortId() }] : undefined,
        }}
      >
        <Show when={props.output}>
          {(output) => (
            <div data-component="tool-output" data-scrollable>
              <ToolTextOutput text={output()} />
            </div>
          )}
        </Show>
      </BasicTool>
    )
  },
})

ToolRegistry.register({
  name: "task_cancel",
  render(props) {
    const description = () => props.metadata.description as string | undefined
    const shortId = () => {
      const id = props.input.task_id || ""
      return id.length > 12 ? id.slice(0, 9) + "…" : id
    }
    return (
      <BasicTool
        {...props}
        trigger={{
          icon: "x",
          title: "Task Cancel",
          subtitle: description() || shortId(),
          tags: description() ? [{ label: shortId() }] : undefined,
        }}
      >
        <Show when={props.output}>
          {(output) => (
            <div data-component="tool-output" data-scrollable>
              <ToolTextOutput text={output()} />
            </div>
          )}
        </Show>
      </BasicTool>
    )
  },
})

ToolRegistry.register({
  name: "memory_search",
  render(props) {
    const count = () => props.metadata?.count as number | undefined
    return (
      <BasicTool
        {...props}
        trigger={{
          icon: "brain",
          title: "Memory Search",
          subtitle: props.input.query || "",
          tags: count() != null ? [{ label: `${count()} result${count() === 1 ? "" : "s"}` }] : undefined,
        }}
      >
        <Show when={props.output}>
          {(output) => (
            <div data-component="tool-output" data-scrollable>
              <ToolTextOutput text={output()} />
            </div>
          )}
        </Show>
      </BasicTool>
    )
  },
})

ToolRegistry.register({
  name: "memory_get",
  render(props) {
    const count = () => props.metadata?.count as number | undefined
    const idList = () => {
      const ids = props.input.ids as string[] | undefined
      if (!ids || ids.length === 0) return ""
      if (ids.length === 1) return ids[0]
      return `${ids.length} memories`
    }
    return (
      <BasicTool
        {...props}
        trigger={{
          icon: "brain",
          title: "Memory Get",
          subtitle: idList(),
          tags: count() != null ? [{ label: `${count()} found` }] : undefined,
        }}
      >
        <Show when={props.output}>
          {(output) => (
            <div data-component="tool-output" data-scrollable>
              <ToolTextOutput text={output()} />
            </div>
          )}
        </Show>
      </BasicTool>
    )
  },
})

ToolRegistry.register({
  name: "memory_write",
  render(props) {
    const action = () => props.metadata?.action as string | undefined
    const status = () => {
      if (action() === "similar_found") return "Similar found"
      if (props.metadata?.id) return "Stored"
      return undefined
    }
    return (
      <BasicTool
        {...props}
        trigger={{
          icon: "brain",
          title: "Memory Write",
          subtitle: props.input.title || props.metadata?.title || "",
          tags: status() ? [{ label: status()! }] : undefined,
        }}
      >
        <Show when={props.output}>
          {(output) => (
            <div data-component="tool-output" data-scrollable>
              <ToolTextOutput text={output()} />
            </div>
          )}
        </Show>
      </BasicTool>
    )
  },
})

ToolRegistry.register({
  name: "memory_edit",
  render(props) {
    const edited = () => !!props.metadata?.id
    return (
      <BasicTool
        {...props}
        trigger={{
          icon: "brain",
          title: "Memory Edit",
          subtitle: props.input.title || props.metadata?.title || "",
          tags: edited() ? [{ label: "Updated" }] : undefined,
        }}
      >
        <Show when={props.output}>
          {(output) => (
            <div data-component="tool-output" data-scrollable>
              <ToolTextOutput text={output()} />
            </div>
          )}
        </Show>
      </BasicTool>
    )
  },
})

ToolRegistry.register({
  name: "note_list",
  render(props) {
    const total = () => props.metadata?.total as number | undefined
    const scope = () => (props.input.scope || props.metadata?.scope || "all") as string
    const kind = () => (props.input.kind || props.metadata?.kind || "all") as string
    const label = () => (kind() === "blueprint" ? "Blueprint" : "Note")
    return (
      <BasicTool
        {...props}
        trigger={{
          icon: "notebook-pen",
          title: kind() === "blueprint" ? "Blueprints" : "Notes",
          subtitle: scope(),
          tags:
            total() != null ? [{ label: `${total()} ${label().toLowerCase()}${total() === 1 ? "" : "s"}` }] : undefined,
        }}
      >
        <Show when={props.output}>
          {(output) => (
            <div data-component="tool-output" data-scrollable>
              <ToolTextOutput text={output()} />
            </div>
          )}
        </Show>
      </BasicTool>
    )
  },
})

ToolRegistry.register({
  name: "note_read",
  render(props) {
    const titles = () => (props.metadata?.titles ?? []) as string[]
    const subtitle = () => {
      const t = titles()
      if (t.length === 0) {
        const ids = props.input.ids as string[] | undefined
        if (!ids || ids.length === 0) return ""
        return ids.length === 1 ? ids[0] : `${ids.length} notes`
      }
      if (t.length === 1) return t[0]
      return `${t.length} notes`
    }
    return (
      <BasicTool
        {...props}
        trigger={{
          icon: "notebook-pen",
          title: "Read Note",
          subtitle: subtitle(),
        }}
      >
        <Show when={props.output}>
          {(output) => (
            <div data-component="tool-output" data-scrollable>
              <ToolTextOutput text={output()} />
            </div>
          )}
        </Show>
      </BasicTool>
    )
  },
})

ToolRegistry.register({
  name: "note_search",
  render(props) {
    const matchCount = () => props.metadata?.matchCount as number | undefined
    const noteCount = () => props.metadata?.noteCount as number | undefined
    const args = () => {
      const parts: string[] = []
      if (matchCount() != null && noteCount() != null) {
        parts.push(
          `${matchCount()} match${matchCount() === 1 ? "" : "es"} in ${noteCount()} note${noteCount() === 1 ? "" : "s"}`,
        )
      }
      return parts
    }
    return (
      <BasicTool
        {...props}
        trigger={{
          icon: "notebook-pen",
          title: "Note Search",
          subtitle: props.input.pattern || "",
          tags: (() => {
            const a = args()
            return a.length > 0 ? a.map((l) => ({ label: l })) : undefined
          })(),
        }}
      >
        <Show when={props.output}>
          {(output) => (
            <div data-component="tool-output" data-scrollable>
              <ToolTextOutput text={output()} />
            </div>
          )}
        </Show>
      </BasicTool>
    )
  },
})

ToolRegistry.register({
  name: "note_write",
  render(props) {
    const action = () => (props.metadata?.action || props.input.mode || "") as string
    const noteTitle = () => (props.metadata?.title || props.input.title || "") as string
    const kind = () => (props.metadata?.kind || props.input.kind || "note") as string
    const label = () => (kind() === "blueprint" ? "Blueprint" : "Note")
    const actionLabel = () => {
      switch (action()) {
        case "create":
          return "Created"
        case "append":
          return "Appended"
        case "replace":
          return "Replaced"
        default:
          return ""
      }
    }
    return (
      <BasicTool
        {...props}
        trigger={{
          icon: "notebook-pen",
          title: `Write ${label()}`,
          subtitle: noteTitle(),
          tags: actionLabel() ? [{ label: actionLabel() }] : undefined,
        }}
      >
        <Show when={props.output}>
          {(output) => (
            <div data-component="tool-output" data-scrollable>
              <ToolTextOutput text={output()} />
            </div>
          )}
        </Show>
      </BasicTool>
    )
  },
})

ToolRegistry.register({
  name: "note_edit",
  render(props) {
    const noteTitle = () => (props.metadata?.title || props.input.title || "") as string
    const replacements = () => props.metadata?.replacements as number | undefined
    return (
      <BasicTool
        {...props}
        trigger={{
          icon: "notebook-pen",
          title: "Edit Note",
          subtitle: noteTitle(),
          tags: replacements() ? [{ label: `${replacements()} change(s)` }] : undefined,
        }}
      >
        <Show when={props.output}>
          {(output) => (
            <div data-component="tool-output" data-scrollable>
              <ToolTextOutput text={output()} />
            </div>
          )}
        </Show>
      </BasicTool>
    )
  },
})

ToolRegistry.register({
  name: "agenda_schedule",
  render(props) {
    return (
      <BasicTool
        {...props}
        trigger={{
          icon: "calendar-days",
          title: "Schedule Agenda",
          subtitle: (props.metadata?.title || props.input.title || "") as string,
          tags: props.metadata?.status ? [{ label: props.metadata.status as string }] : undefined,
        }}
      >
        <Show when={props.output}>
          {(output) => (
            <div data-component="tool-output" data-scrollable>
              <ToolTextOutput text={output()} />
            </div>
          )}
        </Show>
      </BasicTool>
    )
  },
})

ToolRegistry.register({
  name: "agenda_watch",
  render(props) {
    return (
      <BasicTool
        {...props}
        trigger={{
          icon: "eye",
          title: "Watch",
          subtitle: (props.input.title || "") as string,
          tags: props.input.delay ? [{ label: props.input.delay as string }] : undefined,
        }}
      >
        <Show when={props.output}>
          {(output) => (
            <div data-component="tool-output" data-scrollable>
              <ToolTextOutput text={output()} />
            </div>
          )}
        </Show>
      </BasicTool>
    )
  },
})

ToolRegistry.register({
  name: "agenda_list",
  render(props) {
    const count = () => props.metadata?.count as number | undefined
    return (
      <BasicTool
        {...props}
        trigger={{
          icon: "clipboard-list",
          title: "Agenda",
          subtitle: props.input.status || "",
          tags: count() != null ? [{ label: `${count()} item${count() === 1 ? "" : "s"}` }] : undefined,
        }}
      >
        <Show when={props.output}>
          {(output) => (
            <div data-component="tool-output" data-scrollable>
              <ToolTextOutput text={output()} />
            </div>
          )}
        </Show>
      </BasicTool>
    )
  },
})

ToolRegistry.register({
  name: "agenda_update",
  render(props) {
    return (
      <BasicTool
        {...props}
        trigger={{
          icon: "refresh-ccw",
          title: "Update Agenda",
          subtitle: (props.metadata?.title || props.input.id || "") as string,
          tags: props.metadata?.status ? [{ label: props.metadata.status as string }] : undefined,
        }}
      >
        <Show when={props.output}>
          {(output) => (
            <div data-component="tool-output" data-scrollable>
              <ToolTextOutput text={output()} />
            </div>
          )}
        </Show>
      </BasicTool>
    )
  },
})

ToolRegistry.register({
  name: "agenda_cancel",
  render(props) {
    return (
      <BasicTool
        {...props}
        trigger={{
          icon: "trash-2",
          title: "Cancel Agenda",
          subtitle: (props.input.id || "") as string,
        }}
      >
        <Show when={props.output}>
          {(output) => (
            <div data-component="tool-output" data-scrollable>
              <ToolTextOutput text={output()} />
            </div>
          )}
        </Show>
      </BasicTool>
    )
  },
})

ToolRegistry.register({
  name: "agenda_trigger",
  render(props) {
    return (
      <BasicTool
        {...props}
        trigger={{
          icon: "zap",
          title: "Trigger Agenda",
          subtitle: (props.input.id || "") as string,
        }}
      >
        <Show when={props.output}>
          {(output) => (
            <div data-component="tool-output" data-scrollable>
              <ToolTextOutput text={output()} />
            </div>
          )}
        </Show>
      </BasicTool>
    )
  },
})

ToolRegistry.register({
  name: "agenda_logs",
  render(props) {
    const total = () => props.metadata?.total as number | undefined
    return (
      <BasicTool
        {...props}
        trigger={{
          icon: "clock",
          title: "Agenda Logs",
          subtitle: (props.input.id || "") as string,
          tags: total() != null ? [{ label: `${total()} run${total() === 1 ? "" : "s"}` }] : undefined,
        }}
      >
        <Show when={props.output}>
          {(output) => (
            <div data-component="tool-output" data-scrollable>
              <ToolTextOutput text={output()} />
            </div>
          )}
        </Show>
      </BasicTool>
    )
  },
})

ToolRegistry.register({
  name: "attach",
  render(props) {
    const data = useData()
    const files = () =>
      (props.metadata?.files ?? []) as { assetId: string; filename: string; mime: string; size: number }[]
    const totalSize = () => {
      const bytes = files().reduce((sum, f) => sum + f.size, 0)
      if (bytes < 1024) return `${bytes} B`
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
      return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    }
    const subtitle = () => {
      const f = files()
      if (f.length === 1) return f[0].filename
      return `${f.length} files`
    }
    return (
      <BasicTool
        {...props}
        defaultOpen
        trigger={{
          icon: "paperclip",
          title: "Attach",
          subtitle: subtitle(),
          tags: files().length ? [{ label: totalSize() }] : undefined,
        }}
      >
        <Show when={props.status === "completed" && files().length}>
          <AttachmentList files={files()} serverUrl={data.serverUrl} />
        </Show>
      </BasicTool>
    )
  },
})

ToolRegistry.register({
  name: "email_send",
  render(props) {
    const recipients = () => {
      const to = props.input.to
      if (!to) return ""
      return Array.isArray(to) ? to.join(", ") : (to as string)
    }
    return (
      <BasicTool
        {...props}
        trigger={{
          icon: "mail",
          title: "Send Email",
          subtitle: recipients(),
          tags: props.input.subject && recipients() ? [{ label: props.input.subject as string }] : undefined,
        }}
      >
        <Show when={props.output}>
          {(output) => (
            <div data-component="tool-output" data-scrollable>
              <ToolTextOutput text={output()} />
            </div>
          )}
        </Show>
      </BasicTool>
    )
  },
})

ToolRegistry.register({
  name: "email_read",
  render(props) {
    return (
      <BasicTool
        {...props}
        trigger={{
          icon: "mail-search",
          title:
            (props.input.action as string) === "search"
              ? "Search Email"
              : (props.input.action as string) === "read"
                ? "Read Email"
                : (props.input.action as string) === "markSeen"
                  ? "Mark Read"
                  : "Email Inbox",
          subtitle: (props.input.search?.from ||
            props.input.search?.subject ||
            (props.input.folder as string) ||
            "INBOX") as string,
          tags:
            (props.input.folder as string) && props.input.folder !== "INBOX"
              ? [{ label: props.input.folder as string }]
              : undefined,
        }}
      >
        <Show when={props.output}>
          {(output) => (
            <div data-component="tool-output" data-scrollable>
              <ToolTextOutput text={output()} />
            </div>
          )}
        </Show>
      </BasicTool>
    )
  },
})

ToolRegistry.register({
  name: "connect",
  render(props) {
    const actionLabel = () => {
      switch (props.input.action) {
        case "open":
          return "Opening"
        case "close":
          return "Closing"
        case "status":
          return "Status"
        case "list":
          return "List"
        default:
          return props.input.action || ""
      }
    }
    const statusLabel = () => {
      const meta = props.metadata
      if (meta?.status === "opened") return "Connected"
      if (meta?.status === "closed") return "Disconnected"
      return undefined
    }
    return (
      <BasicTool
        {...props}
        trigger={{
          icon: "cable",
          title: "Connect",
          subtitle: props.input.envID || "",
          tags: (() => {
            const l = statusLabel() || actionLabel()
            return l ? [{ label: l }] : undefined
          })(),
        }}
      >
        <Show when={props.output}>
          {(output) => (
            <div data-component="tool-output" data-scrollable>
              <ToolTextOutput text={output()} />
            </div>
          )}
        </Show>
      </BasicTool>
    )
  },
})

ToolRegistry.register({
  name: "runtime_reload",
  render(props) {
    const targetLabel = () => {
      const target = props.input.target
      if (Array.isArray(target)) {
        if (target.length <= 3) return target.join(", ")
        return `${target.length} targets`
      }
      return (target as string) || ""
    }
    const lines = () => {
      const result = props.metadata || {}
      const sections: string[] = []
      const push = (label: string, value: unknown) => {
        if (Array.isArray(value) && value.length > 0) {
          sections.push(`- ${label}: ${value.join(", ")}`)
          return
        }
        if (typeof value === "string" && value) {
          sections.push(`- ${label}: ${value}`)
        }
      }
      push("Requested", result.requested as string[] | undefined)
      push("Executed", result.executed as string[] | undefined)
      push("Cascaded", result.cascaded as string[] | undefined)
      push("Changed Fields", result.changedFields as string[] | undefined)
      push("Live Applied", result.liveApplied as string[] | undefined)
      push("Restart Required", result.restartRequired as string[] | undefined)
      push("Warnings", result.warnings as string[] | undefined)
      return sections
    }
    return (
      <BasicTool
        {...props}
        trigger={{
          icon: "refresh-ccw",
          title: "Runtime Reload",
          subtitle: targetLabel() || (props.input.reason as string) || "",
          tags: props.input.scope ? [{ label: props.input.scope as string }] : undefined,
        }}
      >
        <div data-component="tool-output" data-scrollable>
          <Show
            when={lines().length > 0}
            fallback={<Show when={props.output}>{(output) => <ToolTextOutput text={output()} />}</Show>}
          >
            <div class="flex flex-col gap-1.5 text-12-regular text-text-subtle">
              <For each={lines()}>{(line) => <div>{line}</div>}</For>
            </div>
          </Show>
        </div>
      </BasicTool>
    )
  },
})

ToolRegistry.register({
  name: "render",
  render(props) {
    const html = () => props.metadata?.html as string | undefined
    return (
      <BasicTool
        {...props}
        defaultOpen
        forceOpen
        trigger={{
          icon: "code",
          title: "Render",
          subtitle: props.input.title || "",
          tags: html() ? [{ label: "HTML preview" }] : undefined,
        }}
      >
        <Show
          when={html()}
          fallback={
            <Show when={props.output}>
              {(output) => (
                <div data-component="tool-output">
                  <ToolTextOutput text={output()} />
                </div>
              )}
            </Show>
          }
        >
          {(content) => <RenderHtml html={content()} />}
        </Show>
      </BasicTool>
    )
  },
})
