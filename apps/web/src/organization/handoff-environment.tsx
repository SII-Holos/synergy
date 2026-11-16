import { Show } from "solid-js"
import { useLingui } from "@lingui/solid"
import type { OrganizationHandoffProtocol as Handoff } from "@ericsanchezok/synergy-organization-protocol"
import type { OrgResourceView, OrgCloudEnvironment } from "@ericsanchezok/synergy-sdk/organization"
import { MenuField } from "@ericsanchezok/synergy-ui/menu-field"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { organizationHandoffEnvironmentMessages as messages } from "./handoff-environment-messages"
import { organizationWorkspaceMessages as common } from "./workspace-messages"

export function OrganizationHandoffEnvironment(props: {
  options: NonNullable<Handoff.Options["environment"]>
  value: string
  resourceID: string
  environmentID: string
  resources: readonly OrgResourceView[]
  environments: readonly OrgCloudEnvironment[]
  loading: boolean
  resourceMore: boolean
  more: boolean
  valid: boolean
  onChange(value: string): void
  onResource(value: string): void
  onEnvironment(value: string): void
  onMoreResources(): void
  onMore(): void
  onRefresh(): void
}) {
  const { _ } = useLingui()
  const choices = () => [
    ...(props.options.source.kind === "organization" ? [{ value: "keep", label: _(messages.keep) }] : []),
    ...props.options.choices.map((value) => ({
      value,
      label: _(messages[value === "organization" ? "cloud" : value]),
    })),
  ]
  return (
    <div class="organization-handoff-field">
      <span>{_(messages.environment)}</span>
      <MenuField
        ariaLabel={_(messages.environment)}
        value={props.value}
        triggerLabel={!props.value ? _(messages.chooseEnvironment) : undefined}
        onChange={props.onChange}
        options={choices()}
      />
      <Show when={props.value === "native"}>
        <p>{_(messages.nativeHint)}</p>
      </Show>
      <Show when={props.value === "none"}>
        <p>{_(messages.noneHint)}</p>
      </Show>
      <Show when={props.value === "keep"}>
        <p>{_(messages.keepHint)}</p>
      </Show>
      <Show when={props.value === "organization"}>
        <MenuField
          ariaLabel={_(messages.chooseResource)}
          value={props.resourceID}
          triggerLabel={!props.resourceID ? _(messages.chooseResource) : undefined}
          onChange={props.onResource}
          options={props.resources
            .filter(
              (resource) =>
                resource.state === "enabled" &&
                resource.permissions.use &&
                resource.definition.protocol === "environment",
            )
            .map((resource) => ({ value: resource.resourceID, label: resource.name }))}
        />
        <Show when={props.resourceMore}>
          <Button disabled={props.loading} onClick={props.onMoreResources}>
            {_(common.more)}
          </Button>
        </Show>
        <MenuField
          ariaLabel={_(messages.chooseEnvironment)}
          value={props.environmentID}
          triggerLabel={!props.environmentID ? _(messages.chooseEnvironment) : undefined}
          onChange={props.onEnvironment}
          options={props.environments.map((environment) => ({
            value: environment.environmentID,
            label: environment.name,
          }))}
        />
        <Show when={props.loading}>
          <p role="status">{_(common.loading)}</p>
        </Show>
        <Show when={props.more}>
          <Button disabled={props.loading} onClick={props.onMore}>
            {_(common.more)}
          </Button>
        </Show>
        <Show when={props.resourceID && !props.loading && !props.environments.length}>
          <p>{_(messages.empty)}</p>
        </Show>
        <Button disabled={props.loading || !props.resourceID} onClick={props.onRefresh}>
          {_(messages.refresh)}
        </Button>
      </Show>
      <Show when={!props.valid}>
        <p role="status">{_(messages.incompatible)}</p>
      </Show>
    </div>
  )
}
