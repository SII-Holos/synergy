export type LayoutDiscoveryState = {
  initialSurfacesPresented: boolean
}

export function createInitialLayoutPreferences(): {
  sidebar: { opened: boolean; width: number }
  discovery: LayoutDiscoveryState
} {
  return {
    sidebar: {
      opened: true,
      width: 280,
    },
    discovery: {
      initialSurfacesPresented: false,
    },
  }
}

export function shouldPresentInitialSideWorkspace(input: {
  ready: boolean
  desktop: boolean
  presented: boolean
}): boolean {
  return input.ready && input.desktop && !input.presented
}
