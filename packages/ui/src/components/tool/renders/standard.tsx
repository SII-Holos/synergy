import type { MessageDescriptor } from "@lingui/core"
import { useLingui } from "@lingui/solid"
import { createMemo, For, Show } from "solid-js"
import { Todo } from "@ericsanchezok/synergy-sdk"
import { getFilename } from "@ericsanchezok/synergy-util/path"
import { useData } from "../../../context"
import { BasicTool } from "../../basic-tool"
import { Icon } from "../../icon"
import { Checkbox } from "../../checkbox"
import { RenderHtml } from "../../render-html"
import { AttachmentGallery } from "../../attachment-card"
import { ToolTextOutput } from "../../tool-output-text"
import { ToolRegistry, getToolInfo, getDirectory } from "../../message-part"
import { TOOL_TITLE_DESC, TOOL_MISC_DESC, TOOL_LABEL_DESC } from "../../tool-title-descriptors"
import { getSemanticIcon } from "../../semantic-icon"

function isBlueprintToolKind(input: any = {}, metadata: any = {}) {
  if ((metadata.kind || input.kind) === "blueprint") return true
  const kinds = metadata.kinds
  return Array.isArray(kinds) && kinds.length > 0 && kinds.every((kind) => kind === "blueprint")
}

const BLUEPRINT_ICON = getSemanticIcon("blueprint.main")

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
          title: TOOL_TITLE_DESC["read"],
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
  name: "view_image",
  render(props) {
    return (
      <BasicTool
        {...props}
        trigger={{
          icon: "image",
          title: TOOL_TITLE_DESC["view_image"],
          subtitle: props.input.filePath
            ? getDirectory(props.input.filePath) + getFilename(props.input.filePath)
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
  name: "list",
  render(props) {
    return (
      <BasicTool
        {...props}
        trigger={{
          icon: "folder",
          title: TOOL_TITLE_DESC["list"],
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
    const { _ } = useLingui()
    const count = () => props.metadata?.count as number | undefined
    return (
      <BasicTool
        {...props}
        trigger={{
          icon: "list",
          title: TOOL_TITLE_DESC["session_list"],
          subtitle: props.input.scope || "",
          tags:
            count() != null ? [{ label: _({ ...TOOL_LABEL_DESC.sessions, values: { count: count()! } }) }] : undefined,
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
  name: "scope_list",
  render(props) {
    const { _ } = useLingui()
    const total = () => props.metadata?.total as number | undefined
    return (
      <BasicTool
        {...props}
        trigger={{
          icon: "folder-tree",
          title: TOOL_TITLE_DESC["scope_list"],
          subtitle: props.input.query || "",
          tags:
            total() != null ? [{ label: _({ ...TOOL_LABEL_DESC.scopes, values: { count: total()! } }) }] : undefined,
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
          title: TOOL_TITLE_DESC["session_read"],
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
          title: TOOL_TITLE_DESC["session_search"],
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
          title: TOOL_TITLE_DESC["session_send"],
          subtitle: props.input.target || "",
          tags: props.input.role ? [{ label: props.input.role }] : undefined,
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
  name: "clarus_submit_task_result",
  render(props) {
    return (
      <BasicTool
        {...props}
        trigger={{
          icon: "send",
          title: "Submit Clarus Result",
          subtitle: props.input.success === false ? "Failed" : "Completed",
          tags: props.metadata?.taskID ? [{ label: props.metadata.taskID as string }] : undefined,
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
          title: TOOL_TITLE_DESC["profile_get"],
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
          title: TOOL_TITLE_DESC["profile_update"],
          subtitle: props.input.name || "",
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
  name: "grep",
  render(props) {
    return (
      <BasicTool
        {...props}
        trigger={{
          icon: "search",
          title: TOOL_TITLE_DESC["grep"],
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
          title: TOOL_TITLE_DESC["glob"],
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
        trigger={{
          icon: "mouse-pointer-2",
          title: TOOL_TITLE_DESC["webfetch"],
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
    return (
      <BasicTool
        {...props}
        trigger={{
          icon: "terminal",
          title: TOOL_TITLE_DESC["bash"],
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
          title: TOOL_TITLE_DESC["todowrite"],
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
          title: TOOL_TITLE_DESC["todoread"],
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
    const { _ } = useLingui()
    const count = () => props.input.questions?.length ?? 0
    const answers = () => props.metadata?.answers as string[][] | undefined
    const timedOut = () => props.metadata?.timedOut as boolean | undefined
    return (
      <BasicTool
        {...props}
        trigger={{
          icon: "message-circle",
          title: timedOut() ? TOOL_TITLE_DESC["question_timed_out"] : TOOL_TITLE_DESC["question"],
          subtitle: timedOut()
            ? _(TOOL_TITLE_DESC["question_no_response"])
            : _({ ...TOOL_LABEL_DESC.askedCount, values: { count: count() } }),
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
          title: TOOL_TITLE_DESC["websearch"],
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
    const { _ } = useLingui()
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
      return _({ ...TOOL_LABEL_DESC.files, values: { count: paths.length } })
    }
    return (
      <BasicTool
        {...props}
        trigger={{
          icon: "eye",
          title: props.metadata?.timedOut ? TOOL_TITLE_DESC["look_at_timed_out"] : TOOL_TITLE_DESC["look_at"],
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
          title: TOOL_TITLE_DESC["scan_document"],
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
          title: TOOL_TITLE_DESC["ast_grep"],
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
    const { _ } = useLingui()
    return (
      <BasicTool
        {...props}
        trigger={{
          icon: "text-select",
          title: TOOL_TITLE_DESC["patch"],
          subtitle:
            props.status === "generating"
              ? _(TOOL_TITLE_DESC["patch_generating"])
              : props.metadata.diff
                ? _(TOOL_TITLE_DESC["patch_applied"])
                : "",
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
          title: TOOL_TITLE_DESC["lsp"],
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
          title: TOOL_TITLE_DESC["skill"],
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
  name: "search_tools",
  render(props) {
    const { _ } = useLingui()
    const count = () => props.metadata?.results?.length as number | undefined
    return (
      <BasicTool
        {...props}
        trigger={{
          icon: "tool-search",
          title: TOOL_TITLE_DESC["search_tools"],
          subtitle: props.input.query || "",
          tags:
            count() != null ? [{ label: _({ ...TOOL_LABEL_DESC.matches, values: { count: count()! } }) }] : undefined,
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
  name: "expand_tools",
  render(props) {
    const { _ } = useLingui()
    const groups = () => (props.metadata?.newlyExpandedGroups ?? props.input.groups ?? []) as string[]
    const tools = () => (props.metadata?.newlyActivatedTools ?? props.input.tools ?? []) as string[]
    const target = () => [...groups(), ...tools()].join(", ") || props.input.reason || ""
    return (
      <BasicTool
        {...props}
        trigger={{
          icon: "tool-expand",
          title: TOOL_TITLE_DESC["expand_tools"],
          subtitle: target(),
          tags: props.metadata?.availableRequestedTools?.length ? [{ label: _(TOOL_MISC_DESC.ready) }] : undefined,
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
          title: TOOL_TITLE_DESC["arxiv_search"],
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
          title: TOOL_TITLE_DESC["arxiv_download"],
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
    return (
      <BasicTool
        {...props}
        trigger={{
          icon: "terminal",
          title: TOOL_TITLE_DESC["process"],
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
    const { _ } = useLingui()
    const count = () => props.metadata.count as number | undefined
    return (
      <BasicTool
        {...props}
        trigger={{
          icon: "list-todo",
          title: TOOL_TITLE_DESC["task_list"],
          subtitle: _(TOOL_MISC_DESC.visibleBackgroundTasks),
          tags: count() != null ? [{ label: _({ ...TOOL_LABEL_DESC.tasks, values: { count: count()! } }) }] : undefined,
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
    return (
      <BasicTool
        {...props}
        trigger={{
          icon: "list-todo",
          title: TOOL_TITLE_DESC["task_output"],
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
          title: TOOL_TITLE_DESC["task_cancel"],
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
    const { _ } = useLingui()
    const count = () => props.metadata?.count as number | undefined
    return (
      <BasicTool
        {...props}
        trigger={{
          icon: "brain",
          title: TOOL_TITLE_DESC["memory_search"],
          subtitle: props.input.query || "",
          tags:
            count() != null ? [{ label: _({ ...TOOL_LABEL_DESC.results, values: { count: count()! } }) }] : undefined,
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
    const { _ } = useLingui()
    const count = () => props.metadata?.count as number | undefined
    const idList = () => {
      const ids = props.input.ids as string[] | undefined
      if (!ids || ids.length === 0) return ""
      if (ids.length === 1) return ids[0]
      return _({ ...TOOL_LABEL_DESC.memories, values: { count: ids.length } })
    }
    return (
      <BasicTool
        {...props}
        trigger={{
          icon: "brain",
          title: TOOL_TITLE_DESC["memory_get"],
          subtitle: idList(),
          tags: count() != null ? [{ label: _({ ...TOOL_LABEL_DESC.found, values: { count: count()! } }) }] : undefined,
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
    const { _ } = useLingui()
    const action = () => props.metadata?.action as string | undefined
    return (
      <BasicTool
        {...props}
        trigger={{
          icon: "brain",
          title: TOOL_TITLE_DESC["memory_write"],
          subtitle: props.input.title || props.metadata?.title || "",
          tags:
            action() === "similar_found"
              ? [{ label: _(TOOL_TITLE_DESC["memory_write_similar_found"]) }]
              : props.metadata?.id
                ? [{ label: _(TOOL_TITLE_DESC["memory_write_stored"]) }]
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
  name: "memory_edit",
  render(props) {
    const { _ } = useLingui()
    const edited = () => !!props.metadata?.id
    return (
      <BasicTool
        {...props}
        trigger={{
          icon: "brain",
          title: TOOL_TITLE_DESC["memory_edit"],
          subtitle: props.input.title || props.metadata?.title || "",
          tags: edited() ? [{ label: _(TOOL_MISC_DESC.updated) }] : undefined,
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
    const { _ } = useLingui()
    const total = () => props.metadata?.total as number | undefined
    const scope = () => (props.input.scope || props.metadata?.scope || "all") as string
    const isBlueprint = () => isBlueprintToolKind(props.input, props.metadata)
    return (
      <BasicTool
        {...props}
        trigger={{
          icon: isBlueprint() ? BLUEPRINT_ICON : "notebook-pen",
          title: isBlueprint() ? TOOL_TITLE_DESC["blueprints"] : TOOL_TITLE_DESC["note_list"],
          subtitle: scope(),
          tags:
            total() != null
              ? [
                  {
                    label: isBlueprint()
                      ? _({ ...TOOL_LABEL_DESC.blueprints, values: { count: total()! } })
                      : _({ ...TOOL_LABEL_DESC.notes, values: { count: total()! } }),
                  },
                ]
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
  name: "note_read",
  render(props) {
    const { _ } = useLingui()
    const titles = () => (props.metadata?.titles ?? []) as string[]
    const isBlueprint = () => isBlueprintToolKind(props.input, props.metadata)
    const subtitle = () => {
      const t = titles()
      if (t.length === 0) {
        const ids = props.input.ids as string[] | undefined
        if (!ids || ids.length === 0) return ""
        return ids.length === 1
          ? ids[0]
          : isBlueprint()
            ? _({ ...TOOL_LABEL_DESC.blueprints, values: { count: ids.length } })
            : _({ ...TOOL_LABEL_DESC.notes, values: { count: ids.length } })
      }
      if (t.length === 1) return t[0]
      return isBlueprint()
        ? _({ ...TOOL_LABEL_DESC.blueprints, values: { count: t.length } })
        : _({ ...TOOL_LABEL_DESC.notes, values: { count: t.length } })
    }
    return (
      <BasicTool
        {...props}
        trigger={{
          icon: isBlueprint() ? BLUEPRINT_ICON : "notebook-pen",
          title: isBlueprint() ? TOOL_TITLE_DESC["read_blueprint"] : TOOL_TITLE_DESC["note_read"],
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
    const { _ } = useLingui()
    const matchCount = () => props.metadata?.matchCount as number | undefined
    const noteCount = () => props.metadata?.noteCount as number | undefined
    const isBlueprint = () => isBlueprintToolKind(props.input, props.metadata)
    const countLabel = () => {
      const matches = matchCount()
      const notes = noteCount()
      if (matches == null || notes == null) return undefined
      return isBlueprint()
        ? _({ ...TOOL_LABEL_DESC.matchesInBlueprints, values: { matchCount: matches, noteCount: notes } })
        : _({ ...TOOL_LABEL_DESC.matchesInNotes, values: { matchCount: matches, noteCount: notes } })
    }
    return (
      <BasicTool
        {...props}
        trigger={{
          icon: isBlueprint() ? BLUEPRINT_ICON : "notebook-pen",
          title: isBlueprint() ? TOOL_TITLE_DESC["blueprint_search"] : TOOL_TITLE_DESC["note_search"],
          subtitle: props.input.pattern || "",
          tags: countLabel() ? [{ label: countLabel()! }] : undefined,
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
    const { _ } = useLingui()
    const action = () => (props.metadata?.action || props.input.mode || "") as string
    const noteTitle = () => (props.metadata?.title || props.input.title || "") as string
    const isBlueprint = () => isBlueprintToolKind(props.input, props.metadata)
    const actionLabel = () => {
      switch (action()) {
        case "create":
          return _(TOOL_TITLE_DESC["note_write_created"])
        case "append":
          return _(TOOL_TITLE_DESC["note_write_appended"])
        case "replace":
          return _(TOOL_TITLE_DESC["note_write_replaced"])
        default:
          return ""
      }
    }
    return (
      <BasicTool
        {...props}
        trigger={{
          icon: isBlueprint() ? BLUEPRINT_ICON : "notebook-pen",
          title: isBlueprint() ? TOOL_TITLE_DESC["write_blueprint"] : TOOL_TITLE_DESC["note_write"],
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
    const { _ } = useLingui()
    const noteTitle = () => (props.metadata?.title || props.input.title || "") as string
    const opCount = () => (props.metadata?.opCount ?? props.metadata?.replacements) as number | undefined
    const isBlueprint = () => isBlueprintToolKind(props.input, props.metadata)
    return (
      <BasicTool
        {...props}
        trigger={{
          icon: isBlueprint() ? BLUEPRINT_ICON : "notebook-pen",
          title: isBlueprint() ? TOOL_TITLE_DESC["edit_blueprint"] : TOOL_TITLE_DESC["note_edit"],
          subtitle: noteTitle(),
          tags: opCount() ? [{ label: _({ ...TOOL_LABEL_DESC.changes, values: { count: opCount()! } }) }] : undefined,
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

function BlueprintLoopTool(props: any & { icon: string; title: string | MessageDescriptor; subtitle: string }) {
  return (
    <BasicTool
      {...props}
      trigger={{
        icon: props.icon,
        title: props.title,
        subtitle: props.subtitle,
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
}

ToolRegistry.register({
  name: "blueprint_loop_stop",
  render(props) {
    return (
      <BlueprintLoopTool
        {...props}
        icon="circle-pause"
        title={TOOL_TITLE_DESC["blueprint_loop_stop"]}
        subtitle={(props.input.summary as string) || ""}
      />
    )
  },
})

ToolRegistry.register({
  name: "blueprint_loop_approve",
  render(props) {
    return (
      <BlueprintLoopTool
        {...props}
        icon="file-check-2"
        title={TOOL_TITLE_DESC["blueprint_loop_approve"]}
        subtitle={(props.input.summary as string) || (props.input.sessionID as string) || ""}
      />
    )
  },
})

ToolRegistry.register({
  name: "blueprint_loop_reject",
  render(props) {
    return (
      <BlueprintLoopTool
        {...props}
        icon="clipboard-x"
        title={TOOL_TITLE_DESC["blueprint_loop_reject"]}
        subtitle={(props.input.reason as string) || (props.input.sessionID as string) || ""}
      />
    )
  },
})

ToolRegistry.register({
  name: "loop_stop",
  render(props) {
    return (
      <BasicTool
        {...props}
        trigger={{
          icon: "flag",
          title: TOOL_TITLE_DESC["loop_stop"],
          subtitle: (props.input.summary as string) || "",
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
  name: "light_loop_approve",
  render(props) {
    return (
      <BasicTool
        {...props}
        trigger={{
          icon: "circle-check",
          title: TOOL_TITLE_DESC["light_loop_approve"],
          subtitle: (props.input.summary as string) || (props.input.sessionID as string) || "",
        }}
      />
    )
  },
})

ToolRegistry.register({
  name: "light_loop_reject",
  render(props) {
    return (
      <BasicTool
        {...props}
        trigger={{
          icon: "rotate-ccw",
          title: TOOL_TITLE_DESC["light_loop_reject"],
          subtitle: (props.input.reason as string) || (props.input.sessionID as string) || "",
        }}
      />
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
          title: TOOL_TITLE_DESC["agenda_schedule"],
          subtitle: (props.metadata?.title || props.input.title || "") as string,
          tags: [
            props.metadata?.status ? { label: props.metadata.status as string } : undefined,
            props.metadata?.scheduledTimeoutLabel
              ? { label: props.metadata.scheduledTimeoutLabel as string }
              : undefined,
          ].filter(Boolean) as { label: string }[],
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
          title: TOOL_TITLE_DESC["agenda_watch"],
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
    const { _ } = useLingui()
    const count = () => props.metadata?.count as number | undefined
    return (
      <BasicTool
        {...props}
        trigger={{
          icon: "clipboard-list",
          title: TOOL_TITLE_DESC["agenda_list"],
          subtitle: props.input.status || "",
          tags: count() != null ? [{ label: _({ ...TOOL_LABEL_DESC.items, values: { count: count()! } }) }] : undefined,
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
          title: TOOL_TITLE_DESC["agenda_update"],
          subtitle: (props.metadata?.title || props.input.id || "") as string,
          tags: [
            props.metadata?.status ? { label: props.metadata.status as string } : undefined,
            props.metadata?.scheduledTimeoutLabel
              ? { label: props.metadata.scheduledTimeoutLabel as string }
              : undefined,
          ].filter(Boolean) as { label: string }[],
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
          title: TOOL_TITLE_DESC["agenda_cancel"],
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
          title: TOOL_TITLE_DESC["agenda_trigger"],
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
    const { _ } = useLingui()
    const total = () => props.metadata?.total as number | undefined
    return (
      <BasicTool
        {...props}
        trigger={{
          icon: "clock",
          title: TOOL_TITLE_DESC["agenda_logs"],
          subtitle: (props.input.id || "") as string,
          tags: total() != null ? [{ label: _({ ...TOOL_LABEL_DESC.runs, values: { count: total()! } }) }] : undefined,
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
    const { _ } = useLingui()
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
      return _({ ...TOOL_LABEL_DESC.files, values: { count: f.length } })
    }
    return (
      <BasicTool
        {...props}
        defaultOpen
        trigger={{
          icon: "paperclip",
          title: TOOL_TITLE_DESC["attach"],
          subtitle: subtitle(),
          tags: files().length ? [{ label: totalSize() }] : undefined,
        }}
      >
        <Show when={props.status === "completed" && files().length}>
          <AttachmentGallery files={files()} serverUrl={data.serverUrl} />
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
          title: TOOL_TITLE_DESC["email_send"],
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
              ? TOOL_TITLE_DESC["email_search"]
              : (props.input.action as string) === "read"
                ? TOOL_TITLE_DESC["email_read"]
                : (props.input.action as string) === "markSeen"
                  ? TOOL_TITLE_DESC["email_mark_read"]
                  : TOOL_TITLE_DESC["email_inbox"],
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
    const { _ } = useLingui()
    const actionLabel = () => {
      switch (props.input.action) {
        case "open":
          return _(TOOL_TITLE_DESC["connect_opening"])
        case "close":
          return _(TOOL_TITLE_DESC["connect_closing"])
        case "status":
          return _(TOOL_TITLE_DESC["connect_status"])
        case "list":
          return _(TOOL_TITLE_DESC["connect_list"])
        default:
          return props.input.action || ""
      }
    }
    const statusLabel = () => {
      const meta = props.metadata
      if (meta?.status === "opened") return _(TOOL_TITLE_DESC["connect_connected"])
      if (meta?.status === "closed") return _(TOOL_TITLE_DESC["connect_disconnected"])
      return undefined
    }
    return (
      <BasicTool
        {...props}
        trigger={{
          icon: "cable",
          title: TOOL_TITLE_DESC["connect"],
          subtitle: props.input.linkID || "",
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
    const { _ } = useLingui()
    const targetLabel = () => {
      const target = props.input.target
      if (Array.isArray(target)) {
        if (target.length <= 3) return target.join(", ")
        return _({ ...TOOL_LABEL_DESC.targets, values: { count: target.length } })
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
      push(_(TOOL_MISC_DESC.requested), result.requested as string[] | undefined)
      push(_(TOOL_MISC_DESC.executed), result.executed as string[] | undefined)
      push(_(TOOL_MISC_DESC.cascaded), result.cascaded as string[] | undefined)
      push(_(TOOL_MISC_DESC.changedFields), result.changedFields as string[] | undefined)
      push(_(TOOL_MISC_DESC.liveApplied), result.liveApplied as string[] | undefined)
      push(_(TOOL_MISC_DESC.restartRequired), result.restartRequired as string[] | undefined)
      push(_(TOOL_MISC_DESC.warnings), result.warnings as string[] | undefined)
      return sections
    }
    return (
      <BasicTool
        {...props}
        trigger={{
          icon: "refresh-ccw",
          title: TOOL_TITLE_DESC["runtime_reload"],
          subtitle: targetLabel() || (props.input.reason as string) || "",
          tags: props.input.scope ? [{ label: props.input.scope as string }] : undefined,
        }}
      >
        <div data-component="tool-output" data-scrollable>
          <Show
            when={lines().length > 0}
            fallback={
              <Show keyed when={props.output}>
                {(output) => <ToolTextOutput text={output} />}
              </Show>
            }
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
    const { _ } = useLingui()
    const html = () => props.metadata?.html as string | undefined
    return (
      <BasicTool
        {...props}
        defaultOpen
        forceOpen
        trigger={{
          icon: "code",
          title: TOOL_TITLE_DESC["render"],
          subtitle: props.input.title || "",
          tags: html() ? [{ label: _(TOOL_MISC_DESC.htmlPreview) }] : undefined,
        }}
      >
        <Show
          keyed
          when={html()}
          fallback={
            <Show keyed when={props.output}>
              {(output) => (
                <div data-component="tool-output">
                  <ToolTextOutput text={output} />
                </div>
              )}
            </Show>
          }
        >
          {(content) => <RenderHtml html={content} />}
        </Show>
      </BasicTool>
    )
  },
})

ToolRegistry.register({
  name: "openai_image_gen",
  render(props) {
    return (
      <BasicTool
        {...props}
        trigger={{
          icon: "image",
          title: TOOL_TITLE_DESC["generate_image"],
          subtitlePath: (props.input.output_path as string | undefined) ?? undefined,
          tags: props.input.quality ? [{ label: props.input.quality as string }] : undefined,
        }}
      >
        <Show keyed when={props.output}>
          {(output) => (
            <div data-component="tool-output" data-scrollable>
              <ToolTextOutput text={output} />
            </div>
          )}
        </Show>
      </BasicTool>
    )
  },
})

ToolRegistry.register({
  name: "openai_image_edit",
  render(props) {
    return (
      <BasicTool
        {...props}
        trigger={{
          icon: "image",
          title: TOOL_TITLE_DESC["edit_image"],
          subtitlePath: (props.input.output_path as string | undefined) ?? undefined,
          tags: props.input.quality ? [{ label: props.input.quality as string }] : undefined,
        }}
      >
        <Show keyed when={props.output}>
          {(output) => (
            <div data-component="tool-output" data-scrollable>
              <ToolTextOutput text={output} />
            </div>
          )}
        </Show>
      </BasicTool>
    )
  },
})
