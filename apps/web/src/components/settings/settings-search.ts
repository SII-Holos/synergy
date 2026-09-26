interface SearchableSection {
  id: string
  label: string
  group?: string
  description?: string
  keywords?: readonly string[]
  domainIds?: readonly string[]
  rowLabels?: readonly string[]
}

export function settingsSearchResults<T extends SearchableSection>(sections: readonly T[], query: string) {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
  return sections.flatMap((section) => {
    const matches = (value: string) => terms.every((term) => value.toLocaleLowerCase().includes(term))
    const fields = terms.length ? (section.rowLabels ?? []).filter(matches) : []
    const content = [
      section.label,
      section.group,
      section.description,
      ...(section.keywords ?? []),
      ...(section.domainIds ?? []),
      ...(section.rowLabels ?? []),
    ].join(" ")
    return matches(content) ? [{ section, fields }] : []
  })
}

export function locateSettingsField(root: HTMLElement, label: string) {
  let target: HTMLElement | undefined
  let addedTabIndex = false
  const locate = () => {
    if (target) return
    const title = [
      ...root.querySelectorAll<HTMLElement>(
        ".settings-row-title, .ds-field-label, .ds-section-label, .ds-subsection-title",
      ),
    ].find((node) => node.textContent?.trim().toLocaleLowerCase() === label.trim().toLocaleLowerCase())
    target =
      title?.closest<HTMLElement>(".ds-setting-row, .ds-field, .ds-setting-subsection, .ds-setting-section") ?? title
    if (!target) return
    observer.disconnect()
    addedTabIndex = !target.hasAttribute("tabindex")
    if (addedTabIndex) target.tabIndex = -1
    target.setAttribute("data-settings-search-match", "true")
    target.focus({ preventScroll: true })
    target.scrollIntoView({
      block: "center",
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth",
    })
  }
  const observer = new MutationObserver(locate)
  observer.observe(root, { childList: true, subtree: true, characterData: true })
  locate()
  return () => {
    observer.disconnect()
    target?.removeAttribute("data-settings-search-match")
    if (addedTabIndex) target?.removeAttribute("tabindex")
  }
}
