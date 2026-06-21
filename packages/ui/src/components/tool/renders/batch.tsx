import { createMemo, Show } from "solid-js"
import { BasicTool } from "../../basic-tool"
import { ToolTextOutput } from "../../tool-output-text"
import { ToolRegistry, getQzToolInfo, getToolInfo } from "../../message-part"

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
