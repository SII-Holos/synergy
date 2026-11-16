import { Match, Show, Switch, type JSX } from "solid-js"
import { useLingui } from "@lingui/solid"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { useSpace } from "@/context/space"
import { OrganizationProjects } from "./projects"
import { OrganizationMembers } from "./members"
import { OrganizationResources } from "./resources"
import { OrganizationKnowledge } from "./knowledge"
import { OrganizationAccount } from "./account"
import { OrganizationWorkspaceShell } from "./workspace-shell"
import { WorkspaceError } from "./workspace-error"
import { organizationMemberMessages } from "./member-messages"
import { organizationWorkspaceMessages as messages } from "./workspace-messages"
import "./workspace.css"

export function OrganizationWorkspace(props: { footer: JSX.Element; signOut: () => void }) {
  const space = useSpace()
  const { _ } = useLingui()
  const route = () => {
    const value = space.route()
    return value?.kind === "organization" ? value : undefined
  }
  const managing = () => space.connection()?.account.role !== "member"
  return (
    <OrganizationWorkspaceShell
      footer={props.footer}
      signOut={props.signOut}
      navigation={
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
            <Button
              variant="ghost"
              data-selected={route()?.view === "members"}
              aria-current={route()?.view === "members" ? "page" : undefined}
              onClick={() => space.page("members")}
            >
              {_(messages.members)}
            </Button>
          </Show>
          <Show when={managing()}>
            <Button
              variant="ghost"
              data-selected={route()?.view === "resources"}
              aria-current={route()?.view === "resources" ? "page" : undefined}
              onClick={() => space.page("resources")}
            >
              {_(messages.resources)}
            </Button>
          </Show>
          <Button
            variant="ghost"
            data-selected={route()?.view === "account"}
            aria-current={route()?.view === "account" ? "page" : undefined}
            onClick={() => space.page("account")}
          >
            {_(organizationMemberMessages.account)}
          </Button>
        </nav>
      }
    >
      <div
        class="organization-workspace-main"
        classList={{ "organization-workspace-main--conversation": !!route()?.sessionID }}
      >
        <Switch>
          <Match when={route()?.view === "account" && !route()?.projectID}>
            <OrganizationAccount />
          </Match>
          <Match when={route()?.view === "knowledge" && !route()?.projectID}>
            <OrganizationKnowledge canManage={managing()} />
          </Match>
          <Match when={route()?.view === "members" && !route()?.projectID && managing()}>
            <OrganizationMembers />
          </Match>
          <Match when={route()?.view === "resources" && !route()?.projectID && managing()}>
            <OrganizationResources />
          </Match>
          <Match
            when={!route()?.projectID && !managing() && (route()?.view === "members" || route()?.view === "resources")}
          >
            <WorkspaceError error={{ code: "PERMISSION_DENIED" }} />
            <Button variant="ghost" onClick={() => space.page()}>
              {_(messages.back)}
            </Button>
          </Match>
          <Match when={!route()?.view || route()?.projectID}>
            <OrganizationProjects />
          </Match>
        </Switch>
      </div>
    </OrganizationWorkspaceShell>
  )
}
