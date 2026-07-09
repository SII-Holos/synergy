import { Show, createMemo } from "solid-js"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { Dialog } from "@ericsanchezok/synergy-ui/dialog"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { PermissionDiffList } from "./PermissionDiffList"
import { PermissionRiskBadge } from "./PermissionRiskBadge"
import type { PluginPermissionDiff, PermissionSeverity } from "./schema"

interface UpdateConsentDialogProps {
  pluginId: string
  pluginName: string
  oldVersion: string
  newVersion: string
  diff: PluginPermissionDiff
  onApprove: () => void
  onDeny: () => void
  open: boolean
}

function severityRank(s: PermissionSeverity): number {
  return s === "high" ? 3 : s === "medium" ? 2 : 1
}

function riskDirection(from: PermissionSeverity | undefined, to: PermissionSeverity | undefined) {
  if (!from || !to) return "unchanged"
  const diff = severityRank(to) - severityRank(from)
  if (diff > 0) return "increased"
  if (diff < 0) return "decreased"
  return "unchanged"
}

export function UpdateConsentDialog(props: UpdateConsentDialogProps) {
  const dialog = useDialog()

  const direction = createMemo(() => riskDirection(props.diff.riskBefore, props.diff.riskAfter))
  const isRiskIncreased = () => direction() === "increased"
  const isHighRisk = () => props.diff.riskAfter === "high" && (props.diff.riskBefore ?? "low") !== "high"

  const hasDiff = () =>
    props.diff.added.length > 0 ||
    props.diff.removed.length > 0 ||
    props.diff.unchanged.length > 0 ||
    props.diff.changed.length > 0

  const riskArrowColor = () => {
    switch (direction()) {
      case "increased":
        return "text-text-critical"
      case "decreased":
        return "text-icon-success-base"
      default:
        return "text-text-weak"
    }
  }

  return (
    <Dialog
      title="Update Plugin"
      description={`Review permission changes for ${props.pluginName} before updating.`}
      class="update-consent-dialog"
    >
      <div class="flex flex-col gap-5">
        {/* Plugin identity + version change */}
        <div class="rounded-lg border border-border-weak-base bg-surface-raised-base p-4">
          <div class="flex items-center gap-3">
            <div class="flex size-9 shrink-0 items-center justify-center rounded-lg bg-surface-interactive-weak">
              <Icon name="package" size="small" class="text-icon-interactive-base" />
            </div>
            <div class="min-w-0 flex-1">
              <p class="text-13-medium text-text-strong truncate">{props.pluginName}</p>
              <div class="mt-1 flex items-center gap-1.5 text-12-regular text-text-weak">
                <span class="font-mono text-12-mono">{props.oldVersion}</span>
                <Icon name="arrow-right" size="small" class="shrink-0 opacity-50" />
                <span class="font-mono text-12-mono text-text-base">{props.newVersion}</span>
              </div>
            </div>
          </div>
        </div>

        {/* Risk change */}
        <Show when={props.diff.riskBefore || props.diff.riskAfter}>
          <div class="flex items-center gap-4 rounded-lg border border-border-weak-base bg-surface-raised-base p-4">
            <div class="flex items-center gap-2">
              <span class="text-12-medium text-text-weak uppercase tracking-wider">Risk</span>
              <Show when={props.diff.riskBefore} fallback={<PermissionRiskBadge risk={props.diff.riskAfter!} />}>
                <PermissionRiskBadge risk={props.diff.riskBefore!} />
              </Show>
              <Icon name="arrow-right" size="small" class={riskArrowColor()} />
              <PermissionRiskBadge risk={props.diff.riskAfter!} />
            </div>
            <Show when={isRiskIncreased()}>
              <span class="rounded-full bg-surface-critical-soft px-2 py-0.5 text-11-medium text-text-critical">
                Risk increased
              </span>
            </Show>
            <Show when={direction() === "decreased"}>
              <span class="rounded-full bg-surface-success-soft px-2 py-0.5 text-11-medium text-text-success">
                Risk decreased
              </span>
            </Show>
          </div>
        </Show>

        {/* Permission diff sections */}
        <Show when={hasDiff()}>
          <div class="flex flex-col gap-4">
            {/* Added permissions */}
            <Show when={props.diff.added.length > 0}>
              <div class="rounded-lg border border-border-warning-base bg-surface-warning-soft p-3">
                <p class="text-13-medium text-text-warning mb-2">
                  New permissions requested
                  <span class="ml-1 text-text-weaker text-12-regular">({props.diff.added.length})</span>
                </p>
                <PermissionDiffList items={props.diff.added} mode="added" />
              </div>
            </Show>

            {/* Changed permissions */}
            <Show when={props.diff.changed.length > 0}>
              <div class="rounded-lg border border-border-warning-base bg-surface-warning-soft p-3">
                <p class="text-13-medium text-text-warning mb-2">
                  Modified permissions
                  <span class="ml-1 text-text-weaker text-12-regular">({props.diff.changed.length})</span>
                </p>
                <ul class="flex flex-col gap-1.5">
                  {props.diff.changed.map((change) => (
                    <li class="flex items-center gap-2 rounded-md bg-surface-raised-base px-3 py-2 text-13-regular text-text-base">
                      <Icon name="arrow-right" size="small" class="text-icon-warning-base shrink-0" />
                      <span class="min-w-0 flex-1">
                        <code class="text-12-mono text-text-base">{change.key}</code>
                      </span>
                      <span class="text-12-regular text-text-weak shrink-0">
                        {change.before ?? "(none)"} → {change.after ?? "(none)"}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            </Show>

            {/* Unchanged permissions */}
            <Show when={props.diff.unchanged.length > 0}>
              <details class="rounded-lg border border-border-weak-base bg-surface-raised-base overflow-hidden">
                <summary class="flex items-center gap-2 p-3 cursor-pointer select-none hover:bg-surface-base-hover">
                  <Icon name="chevron-right" size="small" class="text-icon-weak summary-marker" />
                  <p class="text-13-medium text-text-base">
                    Unchanged permissions
                    <span class="ml-1 text-text-weaker text-12-regular">({props.diff.unchanged.length})</span>
                  </p>
                </summary>
                <div class="px-3 pb-3">
                  <PermissionDiffList items={props.diff.unchanged} mode="unchanged" />
                </div>
              </details>
            </Show>

            {/* Removed permissions */}
            <Show when={props.diff.removed.length > 0}>
              <div class="rounded-lg border border-border-success-base bg-surface-success-soft p-3">
                <p class="text-13-medium text-text-success mb-2">
                  No longer required
                  <span class="ml-1 text-text-weaker text-12-regular">({props.diff.removed.length})</span>
                </p>
                <PermissionDiffList items={props.diff.removed} mode="removed" />
              </div>
            </Show>
          </div>
        </Show>

        {/* Reason if provided */}
        <Show when={props.diff.reason}>
          <div class="rounded-md bg-surface-base px-3 py-2">
            <p class="text-12-medium text-text-weak mb-1">Why this update needs new permissions</p>
            <p class="text-13-regular text-text-base">{props.diff.reason}</p>
          </div>
        </Show>

        {/* High risk increase warning */}
        <Show when={isHighRisk() || isRiskIncreased()}>
          <div class="flex items-start gap-2 rounded-lg border border-border-critical-base bg-surface-critical-weak p-3">
            <Icon name="alert-triangle" size="small" class="mt-0.5 text-icon-critical-base shrink-0" />
            <div class="min-w-0">
              <p class="text-13-medium text-text-critical">This update increases the risk level</p>
              <p class="text-12-regular text-text-weak mt-0.5">
                The new version requires higher-risk permissions. Review the changes carefully before approving.
              </p>
            </div>
          </div>
        </Show>
      </div>

      {/* Action buttons */}
      <div class="flex items-center justify-end gap-2 pt-4 mt-2 border-t border-border-weak-base">
        <Button
          type="button"
          variant="ghost"
          size="small"
          onClick={() => {
            props.onDeny()
            dialog.close()
          }}
        >
          Keep current version
        </Button>
        <Button
          type="button"
          variant="primary"
          size="small"
          autofocus
          onClick={() => {
            props.onApprove()
            dialog.close()
          }}
        >
          Approve update
        </Button>
      </div>
    </Dialog>
  )
}
