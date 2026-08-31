import { Show } from "solid-js"
import { DagGraph } from "./dag-graph"
import { DiffPatchGate } from "./diff-patch"
import type { SpecializedActivityDetail } from "./activity-specialized-detail-model"
import { ToolDiffPreview } from "./tool/diff-preview"
import { TaskSubagentDetail } from "./tool/task-subagent-detail"

export function ActivitySpecializedDetail(props: { detail: SpecializedActivityDetail }) {
  return (
    <div data-slot="activity-specialized-detail">
      <Show
        when={props.detail.kind === "diff" ? props.detail : undefined}
        fallback={
          <Show
            when={props.detail.kind === "subagent" ? props.detail : undefined}
            fallback={
              <Show when={props.detail.kind === "dag" ? props.detail : undefined}>
                {(detail) => <DagGraph nodes={detail().nodes} ready={detail().ready} />}
              </Show>
            }
          >
            {(detail) => <TaskSubagentDetail info={detail().info} />}
          </Show>
        }
      >
        {(detail) => (
          <DiffPatchGate
            patch={detail().patch}
            diffStyle="unified"
            fallback={<ToolDiffPreview diff={detail().diff} />}
          />
        )}
      </Show>
    </div>
  )
}
