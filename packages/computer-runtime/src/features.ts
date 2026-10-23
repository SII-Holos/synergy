export const componentFeatures = {
  kind: "product",
  definitions: [
    {
      id: "computer",
      owner: "computer-runtime",
      maturity: "stable",
      activation: "restart",
      name: "Computer",
      description: "Provide computer capabilities.",
      component: "computer-runtime",
    },
  ],
} as const
