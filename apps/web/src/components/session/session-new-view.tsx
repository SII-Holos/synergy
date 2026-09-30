import { useLocale } from "@/context/locale"
import { BRAND_ASSETS, brandAssetPath } from "@/utils/brand-assets"
import { translateDescriptor } from "@/locales/translate"
import { For } from "solid-js"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"

const starters = [
  {
    icon: "task.develop",
    title: { id: "session.starter.develop.title", message: "Develop a project" },
    description: {
      id: "session.starter.develop.description",
      message: "Understand code, plan a change, build something.",
    },
    prompt: {
      id: "session.starter.develop.prompt",
      message:
        "Help me develop this project. First understand the relevant code and propose an implementation plan. My goal is: ",
    },
  },
  {
    icon: "task.research",
    title: { id: "session.starter.research.title", message: "Research a question" },
    description: {
      id: "session.starter.research.description",
      message: "Find sources, compare evidence, draw conclusions.",
    },
    prompt: {
      id: "session.starter.research.prompt",
      message:
        "Research the following question. Compare reliable sources, explain the evidence and cite references. My question is: ",
    },
  },
  {
    icon: "task.write",
    title: { id: "session.starter.write.title", message: "Write something" },
    description: {
      id: "session.starter.write.description",
      message: "Shape an idea, draft content, refine the wording.",
    },
    prompt: {
      id: "session.starter.write.prompt",
      message: "Help me write a clear, well-structured draft. The topic, audience and desired format are: ",
    },
  },
] as const

export function NewSessionGreeting(props: {
  disabled: boolean
  onStart: (text: string) => void
  onProject: () => void
  onFiles: () => void
}) {
  const { i18n } = useLocale()
  return (
    <div class="session-greeting">
      <div class="session-greeting-heading">
        <a href={BRAND_ASSETS.sii.url} target="_blank" rel="noopener noreferrer" class="session-greeting-brand">
          <img src={brandAssetPath(BRAND_ASSETS.sii.logo)} alt={BRAND_ASSETS.sii.name} />
        </a>
        <span class="session-greeting-wordmark">Synergy</span>
      </div>
      <h1>{i18n._({ id: "session.greeting.taskTitle", message: "What would you like to work on?" })}</h1>
      <p>{i18n._({ id: "session.greeting.taskHint", message: "Describe a task or add files to get started." })}</p>
      <div class="session-starter-grid">
        <For each={starters}>
          {(starter) => (
            <button
              type="button"
              class="session-starter-card"
              disabled={props.disabled}
              onClick={() => props.onStart(translateDescriptor(starter.prompt, i18n))}
            >
              <Icon name={getSemanticIcon(starter.icon)} size="large" />
              <span class="session-starter-title">
                {translateDescriptor(starter.title, i18n)}
                <Icon name={getSemanticIcon("navigation.forward")} size="small" />
              </span>
              <span class="session-starter-description">{translateDescriptor(starter.description, i18n)}</span>
            </button>
          )}
        </For>
      </div>
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
    </div>
  )
}
