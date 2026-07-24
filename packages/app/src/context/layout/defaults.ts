export function createInitialLayoutDefaults() {
  return {
    sidebar: {
      opened: true,
      width: 280,
    },
    mobileSidebar: {
      opened: false,
    },
    rightSidebar: {
      opened: false,
    },
    sideWorkspaceDiscovered: false,
  }
}

export function shouldRevealInitialSideWorkspace(input: { ready: boolean; desktop: boolean; discovered: boolean }) {
  return input.ready && input.desktop && !input.discovered
}
