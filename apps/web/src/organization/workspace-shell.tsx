import { createSignal, onMount, type JSX, type ParentProps } from "solid-js"
import { useLingui } from "@lingui/solid"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { useSpace } from "@/context/space"
import { usePlatform } from "@/context/platform"
import { BRAND_ASSETS, brandAssetPath } from "@/utils/brand-assets"
import { organizationSpaceMessages } from "./space-messages"
import "./workspace-shell.css"

export function OrganizationWorkspaceShell(
  props: ParentProps<{ navigation: JSX.Element; footer: JSX.Element; signOut: () => void }>,
) {
  const { _ } = useLingui()
  const space = useSpace()
  const platform = usePlatform()
  const view = space.current()!
  const api = space.client()!
  const [organizationName, setOrganizationName] = createSignal<string>()
  const connection = () => space.connection()!
  const name = () => organizationName() ?? connection().name ?? new URL(connection().issuer).host
  const conversation = () => {
    const route = space.route()
    return route?.kind === "organization" && !!route.sessionID
  }
  onMount(() => {
    void api.orgOrganization
      .get({ signal: view.signal })
      .then((result) => {
        if (!view.signal.aborted && result.data?.orgID === connection().orgID) {
          setOrganizationName(result.data.name)
          space.name(view.key, result.data.name)
        }
      })
      .catch(() => {})
  })
  return (
    <div
      class="organization-workspace-shell"
      classList={{
        "organization-workspace-shell--desktop": platform.platform === "desktop",
        "organization-workspace-shell--conversation": conversation(),
      }}
    >
      <aside class="organization-workspace-sidebar">
        <header class="organization-workspace-identity">
          <img src={brandAssetPath(BRAND_ASSETS.synergy.productIcon)} alt="" />
          <div>
            <h1 title={name()}>{name()}</h1>
            <p title={connection().account.loginName}>{connection().account.displayName}</p>
          </div>
        </header>
        <div class="organization-workspace-sidebar-nav">{props.navigation}</div>
        <div class="organization-workspace-sidebar-footer">
          {props.footer}
          <Button variant="ghost" onClick={props.signOut}>
            {_(organizationSpaceMessages.signOut)}
          </Button>
        </div>
      </aside>
      <div
        class="organization-workspace-pane"
        classList={{ "organization-workspace-pane--conversation": conversation() }}
        data-scroll-viewport="vertical"
      >
        {props.children}
      </div>
    </div>
  )
}
