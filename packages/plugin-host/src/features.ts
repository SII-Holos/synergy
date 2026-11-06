export const componentFeatures = {
  kind: "product",
  definitions: [
    {
      id: "plugin-host",
      owner: "plugin-host",
      maturity: "stable",
      activation: "restart",
      name: "Plugin Host",
      description: "Provide plugin host capabilities.",
      component: "plugin-host",
    },
  ],
} as const
