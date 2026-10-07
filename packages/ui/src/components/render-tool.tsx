import { useLingui } from "@lingui/solid"
import { Show } from "solid-js"
import { useDialog } from "../context/dialog"
import { BasicTool } from "./basic-tool"
import { Dialog } from "./dialog"
import { IconButton } from "./icon-button"
import { RenderHtml } from "./render-html"
import { getSemanticIcon } from "./semantic-icon"
import { Spinner } from "./spinner"
import { TOOL_TITLE_DESC } from "./tool-title-descriptors"
import { ToolTextOutput } from "./tool-output-text"
import type { ToolProps } from "./tool-registry-lazy"
import "./render-tool.css"

const visualDescriptor = { id: "tool.render.visual", message: "Visual result" }
const expandDescriptor = { id: "tool.render.expand", message: "Expand visual" }
const preparingDescriptor = { id: "tool.render.preparing", message: "Preparing visual" }

// Provenance: https://claude.com/blog/claude-builds-visuals
// Local adaptation: keep static visuals in the narrative, with an on-demand shared viewer rather than an artifact workspace.
export function RenderTool(props: ToolProps) {
  const { _ } = useLingui()
  const dialog = useDialog()
  const active = () => props.status === "pending" || props.status === "generating" || props.status === "running"
  const html = () =>
    props.status === "completed" && typeof props.metadata?.html === "string" && props.metadata.html.trim()
      ? props.metadata.html
      : undefined
  const title = () =>
    typeof props.input.artifactTitle === "string" && props.input.artifactTitle.trim()
      ? props.input.artifactTitle
      : _(visualDescriptor)

  const expand = () => {
    const content = html()
    if (!content) return
    const label = title()
    dialog.push(() => {
      let viewer: HTMLDivElement | undefined
      return (
        <div ref={viewer} data-component="render-viewer">
          <Dialog
            title={label}
            size="content"
            initialFocus={() => viewer?.querySelector<HTMLElement>('[data-slot="dialog-close-button"]') ?? undefined}
          >
            <RenderHtml
              html={content}
              title={label}
              expanded
              onEscape={() => viewer?.querySelector<HTMLButtonElement>('[data-slot="dialog-close-button"]')?.click()}
            />
          </Dialog>
        </div>
      )
    })
  }

  return (
    <Show
      when={active() || !!html()}
      fallback={
        <BasicTool {...props} trigger={{ icon: "code", title: TOOL_TITLE_DESC.render }}>
          <Show when={props.output}>
            {(output) => (
              <div data-component="tool-output" data-scrollable>
                <ToolTextOutput text={output()} />
              </div>
            )}
          </Show>
        </BasicTool>
      }
    >
      <figure data-component="render-tool" aria-busy={active()}>
        <Show
          when={html()}
          fallback={
            <div data-slot="render-tool-loading" role="status">
              <span aria-hidden="true">
                <Spinner />
              </span>
              <span>{_(preparingDescriptor)}</span>
            </div>
          }
        >
          <RenderHtml html={html()!} title={title()} maxHeight={480} />
        </Show>
        <figcaption>
          <span>{title()}</span>
          <Show when={html()}>
            <IconButton
              icon={getSemanticIcon("action.expand")}
              variant="ghost"
              aria-label={_(expandDescriptor)}
              onClick={() => expand()}
            />
          </Show>
        </figcaption>
      </figure>
    </Show>
  )
}
