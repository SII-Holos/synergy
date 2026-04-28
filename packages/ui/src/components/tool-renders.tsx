import { createMemo, createEffect, For, Show } from "solid-js"
import { Dynamic } from "solid-js/web"
import { createStore, reconcile } from "solid-js/store"
import { Todo } from "@ericsanchezok/synergy-sdk"
import { getFilename } from "@ericsanchezok/synergy-util/path"
import { checksum } from "@ericsanchezok/synergy-util/encode"
import { parsePartialJson } from "@ericsanchezok/synergy-util/json"
import { useData } from "../context"
import { useDiffComponent } from "../context/diff"
import { useCodeComponent } from "../context/code"
import { createAutoScroll } from "../hooks"
import { BasicTool } from "./basic-tool"
import { Icon } from "./icon"
import { Checkbox } from "./checkbox"
import { DagGraph } from "./dag-graph"
import { DiagramRenderer } from "./diagram"
import { DiffChanges } from "./diff-changes"
import { FileIcon } from "./file-icon"
import { ToolTextOutput } from "./tool-output-text"
import {
  ToolRegistry,
  getToolInfo,
  getQzToolInfo,
  getDirectory,
  getDiagnostics,
  DiagnosticsDisplay,
  type ToolProps,
} from "./message-part"

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
        icon="glasses"
        trigger={() => ({
          title: "Read",
          subtitle: props.input.filePath
            ? getDirectory(props.input.filePath) + getFilename(props.input.filePath)
            : undefined,
          args: rangeLabel() ? [rangeLabel()!] : [],
        })}
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
        icon="folder"
        trigger={() => ({
          title: "List",
          subtitle: props.input.path ? getDirectory(props.input.path) + getFilename(props.input.path) : undefined,
        })}
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
        icon="list"
        trigger={() => ({
          title: "Sessions",
          subtitle: props.input.scope || "",
          args: count() != null ? [`${count()} session${count() === 1 ? "" : "s"}`] : [],
        })}
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
        icon="message-square"
        trigger={() => ({
          title: "Read Session",
          subtitle: props.input.target || "",
        })}
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
        icon="quote"
        trigger={() => ({
          title: "Search Sessions",
          subtitle: props.input.pattern || "",
          args: props.input.scope ? [props.input.scope] : [],
        })}
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
        icon="share"
        trigger={() => ({
          title: "Send Message",
          subtitle: props.input.target || "",
          args: props.input.role ? [props.input.role] : [],
        })}
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
        icon={info().icon}
        trigger={() => ({
          title: info().title,
          subtitle: info().subtitle || "",
          args: props.input.action ? [props.input.action] : [],
        })}
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
        icon="user"
        trigger={() => ({
          title: "Profile",
        })}
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
        icon="user"
        trigger={() => ({
          title: "Update Profile",
          subtitle: props.input.name || "",
        })}
      />
    )
  },
})

ToolRegistry.register({
  name: "agora_search",
  render(props) {
    const count = () => props.metadata?.count as number | undefined
    return (
      <BasicTool
        {...props}
        icon="compass"
        trigger={() => ({
          title: "Agora Search",
          subtitle: props.input.keyword || "",
          args: count() != null ? [`${count()} post${count() === 1 ? "" : "s"}`] : [],
        })}
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
  name: "agora_read",
  render(props) {
    return (
      <BasicTool
        {...props}
        icon="glasses"
        trigger={() => ({
          title: "Agora Read",
          subtitle: props.input.post_id || "",
        })}
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
  name: "agora_post",
  render(props) {
    return (
      <BasicTool
        {...props}
        icon="megaphone"
        trigger={() => ({
          title: "Agora Post",
          subtitle: props.input.title || "",
        })}
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
  name: "agora_join",
  render(props) {
    return (
      <BasicTool
        {...props}
        icon="log-in"
        trigger={() => ({
          title: "Agora Join",
          subtitle: props.input.post_id || "",
        })}
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
  name: "agora_sync",
  render(props) {
    return (
      <BasicTool
        {...props}
        icon="arrow-down-to-line"
        trigger={() => ({
          title: "Agora Sync",
          subtitle: props.input.directory || "",
        })}
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
  name: "agora_submit",
  render(props) {
    return (
      <BasicTool
        {...props}
        icon="upload"
        trigger={() => ({
          title: "Agora Submit",
          subtitle: props.input.comment || "",
        })}
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
  name: "agora_accept",
  render(props) {
    return (
      <BasicTool
        {...props}
        icon="git-merge"
        trigger={() => ({
          title: "Agora Accept",
          subtitle: props.input.answer_id || "",
        })}
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
  name: "agora_comment",
  render(props) {
    return (
      <BasicTool
        {...props}
        icon="message-circle"
        trigger={() => ({
          title: "Agora Comment",
          subtitle: props.input.post_id || "",
        })}
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
        icon="search"
        trigger={() => ({
          title: "Grep",
          subtitle: getDirectory(props.input.path || "/"),
          args: [
            ...(props.input.pattern ? ["pattern=" + props.input.pattern] : []),
            ...(props.input.include ? ["include=" + props.input.include] : []),
          ],
        })}
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
        icon="search"
        trigger={() => ({
          title: "Glob",
          subtitle: (props.input.pattern || "") as string,
        })}
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
        icon="mouse-pointer-2"
        countdown={props.input.timeout ?? 30}
        trigger={() => ({
          title: "Webfetch",
          subtitle: props.input.url || "",
          args: props.input.format ? ["format=" + props.input.format] : [],
          action: (
            <div data-component="tool-action">
              <Icon name="arrow-up-right" size="small" />
            </div>
          ),
        })}
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
  name: "task",
  render(props) {
    const data = useData()
    const summary = () =>
      (props.metadata.summary ?? []) as { id: string; tool: string; state: { status: string; title?: string } }[]
    const isBackground = () => props.metadata.background === true

    const autoScroll = createAutoScroll({
      working: () => true,
    })

    const childSessionId = () => props.metadata.sessionId as string | undefined

    const childPermission = createMemo(() => {
      const sessionId = childSessionId()
      if (!sessionId) return undefined
      const permissions = data.store.permission?.[sessionId] ?? []
      return permissions[0]
    })

    const handleSubtitleClick = () => {
      const sessionId = childSessionId()
      if (sessionId && data.navigateToSession) {
        data.navigateToSession(sessionId)
      }
    }

    return (
      <div data-component="tool-part-wrapper" data-permission={!!childPermission()}>
        <BasicTool
          icon="list-todo"
          defaultOpen={true}
          hideDetails={summary().length === 0}
          trigger={() => ({
            title: `${props.input.subagent_type || props.tool} Agent`,
            titleClass: "capitalize",
            subtitle: props.input.description,
            args: isBackground() ? ["background"] : [],
          })}
          onSubtitleClick={handleSubtitleClick}
        >
          <div
            ref={autoScroll.scrollRef}
            onScroll={autoScroll.handleScroll}
            data-component="tool-output"
            data-scrollable
          >
            <div ref={autoScroll.contentRef} data-component="task-tools">
              <For each={summary()}>
                {(item) => {
                  const info = getToolInfo(item.tool)
                  return (
                    <div data-slot="task-tool-item">
                      <Icon name={info.icon} size="small" />
                      <span data-slot="task-tool-title">{info.title}</span>
                      <Show when={item.state.title}>
                        <span data-slot="task-tool-subtitle">{item.state.title}</span>
                      </Show>
                    </div>
                  )
                }}
              </For>
            </div>
          </div>
        </BasicTool>
      </div>
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
        icon="terminal"
        countdown={countdown()}
        trigger={() => ({
          title: "Shell",
          subtitle: props.input.description,
          args: cmd() ? [cmd()!] : [],
        })}
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
  name: "edit",
  render(props) {
    const diffComponent = useDiffComponent()
    const diagnostics = createMemo(() =>
      props.status === "completed" ? getDiagnostics(props.metadata.diagnostics, props.input.filePath) : [],
    )
    return (
      <BasicTool
        {...props}
        icon="pen-line"
        trigger={
          <div data-component="edit-trigger">
            <div data-slot="message-part-title-area">
              <div data-slot="message-part-title">Edit</div>
              <div data-slot="message-part-path">
                <Show when={props.input.filePath?.includes("/")}>
                  <span data-slot="message-part-directory">{getDirectory(props.input.filePath!)}</span>
                </Show>
                <span data-slot="message-part-filename">{getFilename(props.input.filePath ?? "")}</span>
              </div>
            </div>
            <div data-slot="message-part-actions">
              <Show when={props.metadata.filediff}>
                <DiffChanges changes={props.metadata.filediff} />
              </Show>
            </div>
          </div>
        }
      >
        <Show when={props.status !== "generating" && (props.metadata.filediff?.path || props.input.filePath)}>
          <div data-component="edit-content">
            <Dynamic
              component={diffComponent}
              before={{
                name: props.metadata?.filediff?.file || props.input.filePath || "file",
                contents: props.metadata?.filediff?.before || props.input.oldString,
              }}
              after={{
                name: props.metadata?.filediff?.file || props.input.filePath || "file",
                contents: props.metadata?.filediff?.after || props.input.newString,
              }}
            />
          </div>
        </Show>
        <DiagnosticsDisplay diagnostics={diagnostics()} />
      </BasicTool>
    )
  },
})

ToolRegistry.register({
  name: "write",
  render(props) {
    const codeComponent = useCodeComponent()
    const diagnostics = createMemo(() =>
      props.status === "completed" ? getDiagnostics(props.metadata.diagnostics, props.input.filePath) : [],
    )
    return (
      <BasicTool
        {...props}
        icon="text-select"
        trigger={
          <div data-component="write-trigger">
            <div data-slot="message-part-title-area">
              <div data-slot="message-part-title">Write</div>
              <div data-slot="message-part-path">
                <Show when={props.input.filePath?.includes("/")}>
                  <span data-slot="message-part-directory">{getDirectory(props.input.filePath!)}</span>
                </Show>
                <span data-slot="message-part-filename">{getFilename(props.input.filePath ?? "")}</span>
              </div>
            </div>
            <div data-slot="message-part-actions">{/* <DiffChanges diff={diff} /> */}</div>
          </div>
        }
      >
        <Show when={props.status !== "generating" && (props.input.content || props.input.filePath)}>
          <div data-component="write-content">
            <Dynamic
              component={codeComponent}
              file={{
                name: props.input.filePath ?? "file",
                contents: props.input.content,
                cacheKey: checksum(props.input.content),
              }}
              overflow="scroll"
            />
          </div>
        </Show>
        <DiagnosticsDisplay diagnostics={diagnostics()} />
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
        defaultOpen
        icon="list-checks"
        trigger={() => ({
          title: "To-dos",
          subtitle: firstTodo() || "",
          args: ratio() ? [ratio()] : [],
        })}
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
        icon="list-checks"
        trigger={() => ({
          title: "Read to-dos",
        })}
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
  name: "dagwrite",
  render(props) {
    const nodes = () =>
      (props.metadata?.nodes ?? props.input?.nodes ?? []) as {
        id: string
        content: string
        status: string
        deps: string[]
        assign?: string
      }[]
    const ready = () => (props.metadata?.ready ?? []) as string[]
    const completed = () => nodes().filter((n) => n.status === "completed").length
    const total = () => nodes().length
    const firstReady = () => {
      const readyIds = ready()
      if (readyIds.length > 0) {
        const node = nodes().find((n) => n.id === readyIds[0])
        if (node) {
          const text = node.content
          return text.length > 30 ? text.slice(0, 27) + "…" : text
        }
      }
      const pending = nodes().find((n) => n.status === "pending" || n.status === "running")
      if (pending) {
        const text = pending.content
        return text.length > 30 ? text.slice(0, 27) + "…" : text
      }
      return ""
    }
    const ratio = () => (total() > 0 ? `${completed()}/${total()}` : "")
    return (
      <BasicTool
        {...props}
        defaultOpen
        icon="git-branch"
        trigger={() => ({
          title: "DAG",
          subtitle: firstReady() || "",
          args: ratio() ? [ratio()] : [],
        })}
      >
        <Show when={(nodes()?.length ?? 0) > 0}>
          <DagGraph nodes={nodes()} ready={ready()} />
        </Show>
      </BasicTool>
    )
  },
})

ToolRegistry.register({
  name: "dagpatch",
  render(props) {
    const nodes = () =>
      (props.metadata?.nodes ?? []) as {
        id: string
        content: string
        status: string
        deps: string[]
        assign?: string
      }[]
    const ready = () => (props.metadata?.ready ?? []) as string[]
    const completed = () => nodes().filter((n) => n.status === "completed").length
    const total = () => nodes().length
    const ratio = () => (total() > 0 ? `${completed()}/${total()}` : "")
    return (
      <BasicTool
        {...props}
        defaultOpen
        icon="git-branch"
        trigger={() => ({
          title: "DAG",
          subtitle: "updated",
          args: ratio() ? [ratio()] : [],
        })}
      >
        <Show when={(nodes()?.length ?? 0) > 0}>
          <DagGraph nodes={nodes()} ready={ready()} />
        </Show>
      </BasicTool>
    )
  },
})

ToolRegistry.register({
  name: "dagread",
  render(props) {
    const nodes = () =>
      (props.metadata?.nodes ?? []) as {
        id: string
        content: string
        status: string
        deps: string[]
        assign?: string
      }[]
    const ready = () => (props.metadata?.ready ?? []) as string[]
    const completed = () => nodes().filter((n) => n.status === "completed").length
    const total = () => nodes().length
    const ratio = () => (total() > 0 ? `${completed()}/${total()}` : "")
    return (
      <BasicTool
        {...props}
        defaultOpen
        icon="git-branch"
        trigger={() => ({
          title: "Read DAG",
          args: ratio() ? [ratio()] : [],
        })}
      >
        <Show when={(nodes()?.length ?? 0) > 0}>
          <DagGraph nodes={nodes()} ready={ready()} />
        </Show>
      </BasicTool>
    )
  },
})

ToolRegistry.register({
  name: "diagram",
  render(props) {
    const doc = () => props.metadata?.document as any | undefined
    const stats = () => props.metadata?.stats as Record<string, number> | undefined
    const statsLabel = () => {
      const s = stats()
      if (!s) return ""
      const parts: string[] = []
      if (s.nodes) parts.push(`${s.nodes} nodes`)
      if (s.edges) parts.push(`${s.edges} edges`)
      if (s.items) parts.push(`${s.items} items`)
      if (s.dimensions) parts.push(`${s.dimensions} dims`)
      if (s.steps) parts.push(`${s.steps} steps`)
      if (s.actors) parts.push(`${s.actors} actors`)
      if (s.events) parts.push(`${s.events} events`)
      if (s.depth) parts.push(`depth ${s.depth}`)
      if (s.segments) parts.push(`${s.segments} segments`)
      if (s.series) parts.push(`${s.series} series`)
      if (s.labels) parts.push(`${s.labels} labels`)
      return parts.join(", ")
    }
    return (
      <BasicTool
        {...props}
        defaultOpen
        forceOpen
        icon="layout-grid"
        trigger={() => ({
          title: "Diagram",
          subtitle: props.input.title || "",
          args: statsLabel() ? [statsLabel()] : [],
        })}
      >
        <Show
          when={doc()}
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
          {(document) => <DiagramRenderer document={document()} />}
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
        icon="message-circle"
        countdown={countdown()}
        trigger={() => ({
          title: timedOut() ? "Question Timed Out" : "Questions",
          subtitle: timedOut() ? "No response received" : `Asked ${count()} question${count() !== 1 ? "s" : ""}`,
        })}
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
    const args: string[] = []
    if (props.input.categories) args.push(props.input.categories)
    if (props.input.language) args.push(props.input.language)
    return (
      <BasicTool
        {...props}
        icon="globe"
        trigger={() => ({
          title: "Web Search",
          subtitle: props.input.query || "",
          args,
        })}
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
        icon="eye"
        countdown={countdown()}
        trigger={() => ({
          title: props.metadata?.timedOut ? "Analysis timed out" : "Look at",
          subtitle: props.input.goal || "",
          args: subtitle() ? [subtitle()] : [],
        })}
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
    const args: string[] = []
    if (props.input.lang) args.push(props.input.lang)
    return (
      <BasicTool
        {...props}
        icon="code"
        trigger={() => ({
          title: "AST Search",
          subtitle: props.input.pattern || "",
          args,
        })}
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
  name: "multiedit",
  render(props) {
    const diffComponent = useDiffComponent()
    return (
      <BasicTool
        {...props}
        icon="pen-line"
        trigger={
          <div data-component="edit-trigger">
            <div data-slot="message-part-title-area">
              <div data-slot="message-part-title">Multi Edit</div>
              <div data-slot="message-part-path">
                <Show when={props.input.filePath?.includes("/")}>
                  <span data-slot="message-part-directory">{getDirectory(props.input.filePath!)}</span>
                </Show>
                <span data-slot="message-part-filename">{getFilename(props.input.filePath ?? "")}</span>
              </div>
            </div>
          </div>
        }
      >
        <Show when={props.status !== "generating" && props.metadata.results}>
          {(results) => {
            const lastResult = () => {
              const r = results()
              if (!Array.isArray(r) || r.length === 0) return undefined
              return r[r.length - 1]
            }
            return (
              <Show when={lastResult()?.filediff}>
                {(filediff) => (
                  <div data-component="edit-content">
                    <Dynamic
                      component={diffComponent}
                      before={{
                        name: filediff().file || props.input.filePath || "file",
                        contents: filediff().before,
                      }}
                      after={{
                        name: filediff().file || props.input.filePath || "file",
                        contents: filediff().after,
                      }}
                    />
                  </div>
                )}
              </Show>
            )
          }}
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
        icon="text-select"
        trigger={() => ({
          title: "Patch",
          subtitle: props.status === "generating" ? "Generating patch…" : props.metadata.diff ? "Applied" : "",
        })}
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
    const args: string[] = []
    if (props.input.filePath) args.push(getFilename(props.input.filePath))
    if (props.input.line) args.push(`L${props.input.line}`)
    return (
      <BasicTool
        {...props}
        icon="server"
        trigger={() => ({
          title: "LSP",
          subtitle: props.input.operation || "",
          args,
        })}
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
        icon="sparkles"
        trigger={() => ({
          title: "Skill",
          subtitle: props.input.name + (props.input.reference ? ` (${props.input.reference})` : "") || "",
        })}
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
        icon="file-text"
        trigger={() => ({
          title: "arXiv Search",
          subtitle: props.input.query || "",
        })}
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
        icon="download"
        trigger={() => ({
          title: "arXiv Download",
          subtitle: props.input.arxivId || "",
          args: props.input.outputPath ? [getFilename(props.input.outputPath)] : [],
        })}
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
        icon="terminal"
        countdown={countdown()}
        trigger={() => ({
          title: "Process",
          subtitle: props.input.action || "",
          args: args(),
        })}
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
        icon="list-todo"
        trigger={() => ({
          title: "Task List",
          subtitle: "Visible background tasks",
          args: count() != null ? [`${count()} task${count() === 1 ? "" : "s"}`] : [],
        })}
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
        icon="list-todo"
        countdown={countdown()}
        trigger={() => ({
          title: "Task Output",
          subtitle: description() || shortId(),
          args: description() ? [shortId()] : [],
        })}
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
        icon="x"
        trigger={() => ({
          title: "Task Cancel",
          subtitle: description() || shortId(),
          args: description() ? [shortId()] : [],
        })}
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
        icon="brain"
        trigger={() => ({
          title: "Memory Search",
          subtitle: props.input.query || "",
          args: count() != null ? [`${count()} result${count() === 1 ? "" : "s"}`] : [],
        })}
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
        icon="brain"
        trigger={() => ({
          title: "Memory Get",
          subtitle: idList(),
          args: count() != null ? [`${count()} found`] : [],
        })}
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
        icon="brain"
        trigger={() => ({
          title: "Memory Write",
          subtitle: props.input.title || props.metadata?.title || "",
          args: status() ? [status()!] : [],
        })}
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
        icon="brain"
        trigger={() => ({
          title: "Memory Edit",
          subtitle: props.input.title || props.metadata?.title || "",
          args: edited() ? ["Updated"] : [],
        })}
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
    return (
      <BasicTool
        {...props}
        icon="notebook-pen"
        trigger={() => ({
          title: "Notes",
          subtitle: scope(),
          args: total() != null ? [`${total()} note${total() === 1 ? "" : "s"}`] : [],
        })}
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
        icon="notebook-pen"
        trigger={() => ({
          title: "Read Note",
          subtitle: subtitle(),
        })}
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
        icon="notebook-pen"
        trigger={() => ({
          title: "Note Search",
          subtitle: props.input.pattern || "",
          args: args(),
        })}
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
        icon="notebook-pen"
        trigger={() => ({
          title: "Write Note",
          subtitle: noteTitle(),
          args: actionLabel() ? [actionLabel()] : [],
        })}
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
        icon="calendar-days"
        trigger={() => ({
          title: "Schedule Agenda",
          subtitle: (props.metadata?.title || props.input.title || "") as string,
          args: props.metadata?.status ? [props.metadata.status as string] : [],
        })}
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
        icon="eye"
        trigger={() => ({
          title: "Watch",
          subtitle: (props.input.title || "") as string,
          args: props.input.delay ? [props.input.delay as string] : [],
        })}
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
        icon="clipboard-list"
        trigger={() => ({
          title: "Agenda",
          subtitle: props.input.status || "",
          args: count() != null ? [`${count()} item${count() === 1 ? "" : "s"}`] : [],
        })}
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
        icon="refresh-ccw"
        trigger={() => ({
          title: "Update Agenda",
          subtitle: (props.metadata?.title || props.input.id || "") as string,
          args: props.metadata?.status ? [props.metadata.status as string] : [],
        })}
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
        icon="trash-2"
        trigger={() => ({
          title: "Cancel Agenda",
          subtitle: (props.input.id || "") as string,
        })}
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
        icon="zap"
        trigger={() => ({
          title: "Trigger Agenda",
          subtitle: (props.input.id || "") as string,
        })}
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
        icon="clock"
        trigger={() => ({
          title: "Agenda Logs",
          subtitle: (props.input.id || "") as string,
          args: total() != null ? [`${total()} run${total() === 1 ? "" : "s"}`] : [],
        })}
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
    const resolveAssetUrl = (assetId: string) => `${data.serverUrl.replace(/\/$/, "")}/asset/${assetId}`
    return (
      <BasicTool
        {...props}
        icon="paperclip"
        defaultOpen
        trigger={() => ({
          title: "Attach",
          subtitle: subtitle(),
          args: files().length ? [totalSize()] : [],
        })}
      >
        <Show when={props.status === "completed" && files().length}>
          <div data-component="tool-attachments">
            <For each={files()}>
              {(file) => (
                <a
                  data-component="tool-attachment"
                  href={resolveAssetUrl(file.assetId)}
                  download={file.filename}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <FileIcon node={{ path: file.filename, type: "file" }} />
                  <span data-slot="tool-attachment-filename">{file.filename}</span>
                  <Icon name="download" size="small" />
                </a>
              )}
            </For>
          </div>
        </Show>
      </BasicTool>
    )
  },
})

ToolRegistry.register({
  name: "email",
  render(props) {
    const recipients = () => {
      const to = props.input.to
      if (!to) return ""
      return Array.isArray(to) ? to.join(", ") : (to as string)
    }
    return (
      <BasicTool
        {...props}
        icon="mail"
        trigger={() => ({
          title: "Email",
          subtitle: recipients(),
          args: props.input.subject && recipients() ? [props.input.subject as string] : [],
        })}
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
        icon="mail-search"
        trigger={() => {
          const action = props.input.action as string
          const folder = props.input.folder as string
          return {
            title:
              action === "search"
                ? "Search Email"
                : action === "read"
                  ? "Read Email"
                  : action === "markSeen"
                    ? "Mark Read"
                    : "Email Inbox",
            subtitle: (props.input.search?.from || props.input.search?.subject || folder || "INBOX") as string,
            args: folder && folder !== "INBOX" ? [folder] : [],
          }
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
        icon="cable"
        trigger={() => ({
          title: "Connect",
          subtitle: props.input.envID || "",
          args: [statusLabel() || actionLabel()].filter(Boolean),
        })}
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
        icon="refresh-ccw"
        trigger={() => ({
          title: "Runtime Reload",
          subtitle: targetLabel() || (props.input.reason as string) || "",
          args: props.input.scope ? [props.input.scope as string] : [],
        })}
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

// TODO: legacy qzcli tool registrations — remove when replaced by native inspire tools
const qzToolNames = [
  "qzcli_qz_auth_login",
  "qzcli_qz_set_cookie",
  "qzcli_qz_list_workspaces",
  "qzcli_qz_refresh_resources",
  "qzcli_qz_get_availability",
  "qzcli_qz_list_jobs",
  "qzcli_qz_get_job_detail",
  "qzcli_qz_stop_job",
  "qzcli_qz_get_usage",
  "qzcli_qz_inspect_status_catalog",
  "qzcli_qz_track_job",
  "qzcli_qz_list_tracked_jobs",
  "qzcli_qz_create_job",
  "qzcli_qz_create_hpc_job",
  "qzcli_qz_get_hpc_usage",
] as const

for (const name of qzToolNames) {
  ToolRegistry.register({
    name,
    render(props) {
      const info = getQzToolInfo(name, props.input, props.metadata)
      if (!info) return undefined as any
      return (
        <BasicTool
          {...props}
          icon={info.icon}
          trigger={() => ({
            title: info.title,
            subtitle: info.subtitle || "",
            args: info.args || [],
          })}
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
}

const inspireToolNames = [
  "inspire_status",
  "inspire_config",
  "inspire_login",
  "inspire_images",
  "inspire_image_push",
  "inspire_submit",
  "inspire_submit_hpc",
  "inspire_stop",
  "inspire_jobs",
  "inspire_job_detail",
  "inspire_logs",
  "inspire_metrics",
  "inspire_inference",
  "inspire_models",
  "inspire_notebook",
] as const

for (const name of inspireToolNames) {
  ToolRegistry.register({
    name,
    render(props) {
      const info = createMemo(() =>
        getToolInfo(name, props.input, { ...props.metadata, title: props.title ?? props.metadata?.title }),
      )
      return (
        <BasicTool
          {...props}
          icon={info().icon}
          trigger={() => ({
            title: info().title,
            subtitle: info().subtitle || "",
            args: info().args || [],
          })}
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
}

const researchToolNames = [
  "research_init",
  "research_state",
  "research_idea",
  "research_plan",
  "research_experiment",
  "research_claim",
  "research_exhibit",
  "research_paper",
  "research_submission",
  "research_wiki",
  "research_timeline",
] as const

for (const name of researchToolNames) {
  ToolRegistry.register({
    name,
    render(props) {
      const info = createMemo(() =>
        getToolInfo(name, props.input, { ...props.metadata, title: props.title ?? props.metadata?.title }),
      )
      return (
        <BasicTool
          {...props}
          icon={info().icon}
          trigger={() => ({
            title: info().title,
            subtitle: info().subtitle || "",
            args: info().args || [],
          })}
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
}
