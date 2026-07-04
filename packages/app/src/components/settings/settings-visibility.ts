export const SETTINGS_DEVELOPER_MODE_STORAGE_KEY = "synergy.settings.developerMode"

export type SettingsSectionVisibility = "standard" | "developer"

export interface VisibleSection {
  id: string
  visibility?: SettingsSectionVisibility
  hidden?: boolean
}

/** Pure filter: hidden sections are always hidden; developer sections need developerMode=true */
export function sectionVisible(section: VisibleSection, developerMode: boolean): boolean {
  if (section.hidden) return false
  if (section.visibility === "developer") return developerMode
  return true
}

/** Pure filter: returns sections that pass sectionVisible */
export function filterSettingsSections<T extends VisibleSection>(sections: T[], developerMode: boolean): T[] {
  return sections.filter((s) => sectionVisible(s, developerMode))
}
