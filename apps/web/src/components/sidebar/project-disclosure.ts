export function shouldOpenProjectDisclosure(input: {
  expanded: boolean
  isSupplemental: boolean
  navLoaded: boolean
  navError?: boolean
}): boolean {
  if (!input.expanded) return false
  return input.isSupplemental || input.navLoaded || !!input.navError
}
