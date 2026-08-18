import { createMemo, Show } from "solid-js"
import { BasicTool } from "../../basic-tool"
import { ToolTextOutput } from "../../tool-output-text"
import { ToolRegistry, getToolInfo } from "../../message-part"

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
          trigger={{
            icon: info().icon,
            title: info().title,
            subtitle: info().subtitle || "",
            tags: info().args?.map((a) => ({ label: a })),
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
          trigger={{
            icon: info().icon,
            title: info().title,
            subtitle: info().subtitle || "",
            tags: info().args?.map((a) => ({ label: a })),
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
}

const worktreeToolNames = ["worktree_enter", "worktree_leave", "worktree_list"] as const

for (const name of worktreeToolNames) {
  ToolRegistry.register({
    name,
    render(props) {
      const info = createMemo(() =>
        getToolInfo(name, props.input, { ...props.metadata, title: props.title ?? props.metadata?.title }),
      )
      return (
        <BasicTool
          {...props}
          trigger={{
            icon: info().icon,
            title: info().title,
            subtitle: info().subtitle || "",
            tags: info().args?.map((a) => ({ label: a })),
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
}
