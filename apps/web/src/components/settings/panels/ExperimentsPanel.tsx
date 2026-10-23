import type { MessageDescriptor } from "@lingui/core"
import { For, Show } from "solid-js"
import { useLingui } from "@lingui/solid"
import { Switch } from "@ericsanchezok/synergy-ui/switch"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { SettingsPage, SettingsSection } from "../components/SettingsPrimitives"
import { SettingRow } from "../components/SettingsSettingRow"
import { featureCopy } from "../feature-copy"
import type { ExperimentsController } from "./experiments-controller"
import { getBuiltinSettingsSection } from "../catalog"

export function ExperimentsPanel(props: { controller: ExperimentsController; onRetrySave(): void }) {
  const { _ } = useLingui()
  const translate = (descriptor: MessageDescriptor) => _(descriptor)
  const controller = props.controller
  const copy = getBuiltinSettingsSection("experiments")!.copy
  const items = () => controller.catalog().filter((item) => item.definition?.maturity !== "stable")
  return (
    <SettingsPage title={translate(copy.label)} description={translate(copy.description)}>
      <Show when={controller.error()}>
        <div role="alert">
          {controller.error()?.operation === "save"
            ? _({ id: "settings.experiments.saveFailed", message: "Couldn't confirm changes. Your draft is kept." })
            : _({ id: "settings.experiments.loadFailed", message: "Couldn't load experimental features." })}
        </div>
        <Button
          variant="secondary"
          onClick={() => (controller.error()?.operation === "save" ? props.onRetrySave() : void controller.load())}
        >
          {_({ id: "settings.experiments.retry", message: "Retry" })}
        </Button>
      </Show>
      <Show
        when={controller.loaded()}
        fallback={
          <Show when={controller.status() === "loading"}>
            <p role="status">{_({ id: "settings.experiments.loading", message: "Loading…" })}</p>
          </Show>
        }
      >
        <SettingsSection>
          <For
            each={items()}
            fallback={<p>{_({ id: "settings.experiments.empty", message: "No experimental features available." })}</p>}
          >
            {(item) => {
              const copy = featureCopy[item.id]
              const name = () => (copy ? translate(copy.name) : (item.definition?.name ?? item.id))
              const description = () => (copy ? translate(copy.description) : item.definition?.description)
              const state = () => {
                if (controller.selected(item.id) !== item.selected)
                  return _({ id: "settings.experiments.unsaved", message: "Not saved" })
                if (item.pendingRestart)
                  return _({ id: "settings.experiments.pending", message: "Saved. Restart to apply." })
                if (!item.available)
                  return item.reason === "not-installed"
                    ? _({
                        id: "settings.experiments.notInstalled",
                        message: "Not installed",
                      })
                    : item.reason === "dependency-unavailable"
                      ? _({
                          id: "settings.experiments.dependencyUnavailable",
                          message: "Required feature unavailable",
                        })
                      : _({
                          id: "settings.experiments.unselected",
                          message: "Unavailable here",
                        })
                return item.definition?.activation === "live"
                  ? _({ id: "settings.experiments.live", message: "Applies to the next action after saving" })
                  : _({ id: "settings.experiments.restart", message: "Requires restart" })
              }
              return (
                <SettingRow
                  title={name()}
                  description={description()}
                  stateLabel={state()}
                  controlLayout="compact"
                  trailing={
                    <Switch
                      checked={controller.selected(item.id)}
                      disabled={
                        controller.status() === "saving" ||
                        (!item.available && !item.selected && !controller.selected(item.id))
                      }
                      onChange={(checked) => controller.toggle(item.id, checked)}
                    />
                  }
                />
              )
            }}
          </For>
        </SettingsSection>
      </Show>
    </SettingsPage>
  )
}
