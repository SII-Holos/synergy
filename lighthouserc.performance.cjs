module.exports = {
  ci: {
    collect: {
      url: [process.env.SYNERGY_PERF_APP_URL || "http://127.0.0.1:3000"],
      numberOfRuns: Number(process.env.SYNERGY_LIGHTHOUSE_RUNS || 1),
      settings: {
        preset: "desktop",
        throttlingMethod: "simulate",
        onlyCategories: ["performance"],
      },
    },
    assert: {
      assertions: {
        "categories:performance": ["warn", { minScore: 0.6 }],
        "first-contentful-paint": ["warn", { maxNumericValue: 3000 }],
        interactive: ["warn", { maxNumericValue: 7000 }],
      },
    },
    upload: {
      target: "filesystem",
      outputDir: "artifacts/performance/lighthouse",
    },
  },
}
