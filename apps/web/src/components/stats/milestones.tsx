import { useLocale } from "@/context/locale"
import { S } from "./stats-i18n"

export function Milestones(_props: { snapshot: unknown }) {
  const { i18n } = useLocale()
  return (
    <section class="rounded-xl bg-surface-inset-base/35 px-4 py-3">
      <div class="app-panel-caption font-medium text-text-weak">{i18n._(S.milestoneTitle.id)}</div>
      <p class="mt-1 app-panel-caption text-text-subtle">{i18n._(S.milestoneSubtitle.id)}</p>
    </section>
  )
}
