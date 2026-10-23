import { useLocale } from "@/context/locale"
import { useSync } from "@/context/sync"
import { Show } from "solid-js"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { useWelcome } from "./welcome/context"
import { welcomeScenes } from "./welcome/registry"
import { WelcomeHeading, WelcomeStage } from "./welcome/stage"

export function NewSessionGreeting(props: { disabled: boolean; onProject: () => void; onFiles: () => void }) {
  const { i18n } = useLocale()
  const welcome = useWelcome()
  const sync = useSync()
  const dialog = useDialog()
  const actions = () => (
    <div class="session-starter-actions">
      <button type="button" onClick={props.onProject}>
        <Icon name={getSemanticIcon("workspace.add")} size="small" />
        {i18n._({ id: "session.starter.openProject", message: "Open a project" })}
      </button>
      <button type="button" disabled={props.disabled} onClick={props.onFiles}>
        <Icon name={getSemanticIcon("prompt.attach")} size="small" />
        {i18n._({ id: "session.starter.addFiles", message: "Add files" })}
      </button>
    </div>
  )
  return (
    <Show
      when={(sync.data.config.welcomeGames ?? true) && welcome?.experience()}
      keyed
      fallback={
        <div class="session-greeting">
          <WelcomeHeading />
          {actions()}
        </div>
      }
    >
      {(experience) => (
        <WelcomeStage
          definition={welcomeScenes.find((scene) => scene.id === experience.selection.sceneId)!}
          seed={experience.selection.seed}
          memory={experience.memory}
          blocked={!!dialog.active}
        />
      )}
    </Show>
  )
}
