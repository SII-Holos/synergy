export const componentFeatures = {
  kind: "product",
  definitions: [
    {
      id: "workbench",
      owner: "workbench",
      maturity: "stable",
      activation: "restart",
      name: "Workbench",
      description: "Projects, task presentation, reviews and activity.",
      component: "workbench",
    },
    {
      id: "kanban",
      owner: "workbench",
      maturity: "experimental",
      activation: "restart",
      name: "Kanban",
      description: "View and organize tasks on a board.",
    },
  ],
} as const
