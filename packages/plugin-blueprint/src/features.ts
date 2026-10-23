export const componentFeatures = {
  kind: "bridge",
  definitions: [
    {
      id: "plugin-blueprint",
      owner: "plugin-blueprint",
      maturity: "stable",
      activation: "restart",
      name: "Plugin Blueprint",
      description: "Provide plugin blueprint capabilities.",
      component: "plugin-blueprint",
    },
  ],
} as const
