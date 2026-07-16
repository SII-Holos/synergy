import { TOOL_TITLE_DESC, TOOL_MISC_DESC } from "../../tool-title-descriptors"
import { Show } from "solid-js"
import { BasicTool } from "../../basic-tool"
import { DagGraph } from "../../dag-graph"
import { ToolRegistry } from "../../message-part"
import { getSemanticIcon } from "../../semantic-icon"

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
          const text = node.content ?? ""
          return text.length > 30 ? text.slice(0, 27) + "…" : text
        }
      }
      const pending = nodes().find((n) => n.status === "pending" || n.status === "running")
      if (pending) {
        const text = pending.content ?? ""
        return text.length > 30 ? text.slice(0, 27) + "…" : text
      }
      return ""
    }
    const ratio = () => (total() > 0 ? `${completed()}/${total()}` : "")
    return (
      <BasicTool
        {...props}
        trigger={{
          icon: getSemanticIcon("dag.main"),
          title: TOOL_TITLE_DESC["dagwrite"],
          subtitle: firstReady() || "",
          tags: ratio() ? [{ label: ratio() }] : undefined,
        }}
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
        trigger={{
          icon: getSemanticIcon("dag.main"),
          title: TOOL_TITLE_DESC["dagpatch"],
          subtitle: TOOL_MISC_DESC.updated.message!,
          tags: ratio() ? [{ label: ratio() }] : undefined,
        }}
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
        trigger={{
          icon: getSemanticIcon("dag.main"),
          title: TOOL_TITLE_DESC["dagread"],
          tags: ratio() ? [{ label: ratio() }] : undefined,
        }}
      >
        <Show when={(nodes()?.length ?? 0) > 0}>
          <DagGraph nodes={nodes()} ready={ready()} />
        </Show>
      </BasicTool>
    )
  },
})
