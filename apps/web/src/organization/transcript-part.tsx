import { createMemo, Show } from "solid-js"
import { useLingui } from "@lingui/solid"
import type { Message, Part as MessagePart } from "@ericsanchezok/synergy-sdk"
import { Part, getToolInfo } from "@ericsanchezok/synergy-ui/message-part"
import { ToolTrigger } from "@ericsanchezok/synergy-ui/tool/trigger"
import type { OrganizationPartData } from "./transcript"

const statuses = {
  pending: { id: "organization.transcript.pending", message: "Pending" },
  generating: { id: "organization.transcript.generating", message: "Receiving input" },
  running: { id: "organization.transcript.running", message: "Running" },
  completed: { id: "organization.transcript.completed", message: "Completed" },
  error: { id: "organization.transcript.error", message: "Failed" },
}

function input(value: unknown) {
  if (typeof value !== "string") return
  try {
    return JSON.parse(value) as unknown
  } catch {
    return
  }
}

export function OrganizationTranscriptPart(props: {
  record: OrganizationPartData
  part?: MessagePart
  message: Message
}) {
  const { _ } = useLingui()
  const tool = createMemo(() => (props.record.part?.type === "tool" ? props.record.part : undefined))
  const info = createMemo(() => {
    const value = tool()
    return (
      value &&
      getToolInfo(value.tool, value.input.kind === "inline" ? input(value.input.text) : undefined, value.metadata)
    )
  })
  return (
    <Show when={props.part || tool()}>
      <div data-part-id={props.record.partID} data-content-state={props.part ? "ready" : "deferred"}>
        <Show
          when={props.part}
          fallback={
            <Show when={tool()}>
              {(value) => (
                <div class="organization-deferred-tool">
                  <div>
                    <ToolTrigger
                      icon={info()!.icon}
                      title={info()!.title}
                      subtitle={info()!.subtitle}
                      tags={info()!.args?.map((label) => ({ label }))}
                    />
                    <span>{_(statuses[value().status])}</span>
                  </div>
                  <p>{_({ id: "organization.transcript.deferred", message: "Load content to read this result." })}</p>
                </div>
              )}
            </Show>
          }
        >
          {(part) => <Part part={part()} message={props.message} />}
        </Show>
      </div>
    </Show>
  )
}
