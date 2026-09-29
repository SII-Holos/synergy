import { useLocale } from "@/context/locale"
import { BRAND_ASSETS, brandAssetPath } from "@/utils/brand-assets"

export function NewSessionGreeting() {
  const { i18n } = useLocale()
  return (
    <div class="session-greeting">
      <a href={BRAND_ASSETS.sii.url} target="_blank" rel="noopener noreferrer" class="session-greeting-brand">
        <img src={brandAssetPath(BRAND_ASSETS.sii.logo)} alt={BRAND_ASSETS.sii.name} />
      </a>
      <h1>{i18n._({ id: "session.greeting.taskTitle", message: "What would you like to work on?" })}</h1>
      <p>{i18n._({ id: "session.greeting.taskHint", message: "Describe a task or add files to get started." })}</p>
    </div>
  )
}
