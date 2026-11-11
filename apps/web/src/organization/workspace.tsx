import { Match, Show, Switch } from "solid-js"
import { useLingui } from "@lingui/solid"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { useSpace } from "@/context/space"
import { OrganizationProjects } from "./projects"
import { OrganizationMembers } from "./members"
import { OrganizationResources } from "./resources"
import { OrganizationKnowledge } from "./knowledge"
import { organizationWorkspaceMessages as messages } from "./workspace-messages"
import "./workspace.css"

export function OrganizationWorkspace() {
  const space = useSpace()
  const { _ } = useLingui()
  const route = () => {
    const value = space.route()
    return value?.kind === "organization" ? value : undefined
  }
  const managing = () => space.connection()?.account.role !== "member"
  return (
    <div class="organization-workspace">
      <nav
        class="organization-workspace-nav"
        aria-label={_({ id: "organization.workspace.navigation", message: "Organization navigation" })}
      >
        <Button
          variant="ghost"
          data-selected={!route()?.view || !!route()?.projectID}
          aria-current={!route()?.view || route()?.projectID ? "page" : undefined}
          onClick={() => space.page()}
        >
          {_(messages.projects)}
        </Button>
        <Button
          variant="ghost"
          data-selected={route()?.view === "knowledge" && !route()?.projectID}
          aria-current={route()?.view === "knowledge" && !route()?.projectID ? "page" : undefined}
          onClick={() => space.page("knowledge")}
        >
          {_(messages.knowledge)}
        </Button>
        <Show when={managing()}>
          <Button variant="ghost" data-selected={route()?.view === "members"} onClick={() => space.page("members")}>
            {_(messages.members)}
          </Button>
        </Show>
        <Show when={managing()}>
          <Button variant="ghost" data-selected={route()?.view === "resources"} onClick={() => space.page("resources")}>
            {_(messages.resources)}
          </Button>
        </Show>
      </nav>
      <div class="organization-workspace-main">
        <Switch>
          <Match when={route()?.view === "knowledge" && !route()?.projectID}>
            <OrganizationKnowledge canManage={managing()} />
          </Match>
          <Match when={route()?.view === "members" && !route()?.projectID && managing()}>
            <OrganizationMembers />
          </Match>
          <Match when={route()?.view === "resources" && !route()?.projectID && managing()}>
            <OrganizationResources />
          </Match>
          <Match when={!route()?.view || route()?.projectID}>
            <OrganizationProjects />
          </Match>
        </Switch>
      </div>
    </div>
  )
}
