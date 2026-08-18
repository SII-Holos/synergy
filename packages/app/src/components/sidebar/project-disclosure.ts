export function shouldOpenProjectDisclosure(input: {
  expanded: boolean
  isSupplemental: boolean
  navLoaded: boolean
}): boolean {
  if (!input.expanded) return false
  return input.isSupplemental || input.navLoaded
}
