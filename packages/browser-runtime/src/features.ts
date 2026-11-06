export const componentFeatures = {
  kind: "product",
  definitions: [
    {
      id: "browser",
      owner: "browser-runtime",
      maturity: "stable",
      activation: "restart",
      name: "Browser",
      description: "Provide browser capabilities.",
      component: "browser-runtime",
    },
  ],
} as const
