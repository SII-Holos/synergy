import { createMemo, createSignal, onCleanup, Show } from "solid-js"
import { useLingui } from "@lingui/solid"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { SettingRow } from "@ericsanchezok/synergy-ui/setting-row"
import { MenuField } from "@ericsanchezok/synergy-ui/menu-field"
import { usePluginHost } from "./host"
import { listShells, subscribeShells } from "./registries/shell-registry"

export function ShellPreferenceRow(props: { popoverLayer?: HTMLElement }) {
  const host = usePluginHost()
  const { _ } = useLingui()
  const [revision, setRevision] = createSignal(0)
  onCleanup(subscribeShells(() => setRevision((value) => value + 1)))
  const title = () => _({ id: "app.plugin.shell.preference.title", message: "Workbench" })
  const options = createMemo(() => {
    revision()
    const available = listShells().map((entry) => ({
      value: entry.id,
      label: entry.label ?? entry.id,
      disabled: false,
    }))
    if (!available.some((entry) => entry.value === host.shell.selected())) {
      available.push({
        value: host.shell.selected(),
        label: _({
          id: "app.plugin.shell.preference.unavailable",
          message: "{shell} (unavailable)",
          values: { shell: host.shell.selected() },
        }),
        disabled: true,
      })
    }
    return available
  })
  return (
    <>
      <SettingRow
        title={title()}
        description={
          host.safeUI
            ? _({
                id: "app.plugin.shell.preference.recovery",
                message: "Safe UI is active. Choose the default workbench before restarting if a plugin failed.",
              })
            : _({
                id: "app.plugin.shell.preference.description",
                message: "Choose how this server's workbench and pages are presented.",
              })
        }
        trailing={
          <MenuField
            value={host.shell.selected()}
            options={options()}
            onChange={host.shell.select}
            ariaLabel={title()}
            popoverLayer={props.popoverLayer}
          />
        }
      />
      <Show when={host.safeUI}>
        <Button
          onClick={() => {
            const url = new URL(window.location.href)
            url.searchParams.set("safe-ui", "0")
            window.location.replace(url.href)
          }}
        >
          {_({ id: "app.plugin.shell.preference.restart", message: "Restart normally" })}
        </Button>
      </Show>
    </>
  )
}
