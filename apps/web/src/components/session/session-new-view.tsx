import { useLocale } from "@/context/locale"
import { useSync } from "@/context/sync"
import { BRAND_ASSETS, brandAssetPath } from "@/utils/brand-assets"
import { Show } from "solid-js"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { useWelcome } from "./welcome/context"
import { welcomeScenes } from "./welcome/registry"
import { WelcomeStage } from "./welcome/stage"

export function NewSessionGreeting(props: {
  interactive: boolean
  disabled: boolean
  onProject: () => void
  onFiles: () => void
}) {
  const { i18n } = useLocale()
  const welcome = useWelcome()
  const sync = useSync()
  const dialog = useDialog()
  const brand = () => (
    <div class="session-greeting-heading">
      <a href={BRAND_ASSETS.sii.url} target="_blank" rel="noopener noreferrer" class="session-greeting-brand">
        <img src={brandAssetPath(BRAND_ASSETS.sii.logo)} alt={BRAND_ASSETS.sii.name} />
      </a>
      <span class="session-greeting-wordmark">Synergy</span>
    </div>
  )
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
      when={props.interactive && (sync.data.config.welcomeGames ?? true) && welcome?.experience()}
      keyed
      fallback={
        <div class="session-greeting">
          {brand()}
          <h1>{i18n._({ id: "session.greeting.taskTitle", message: "What would you like to work on?" })}</h1>
          <p>{i18n._({ id: "session.greeting.taskHint", message: "Describe a task or add files to get started." })}</p>
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
