// Provenance: Oxlint JS plugins — https://oxc.rs/docs/guide/usage/linter/js-plugins
// Local adaptation: oxlint does not implement eslint/no-restricted-syntax, so the
// selector and message options in oxlintrc.json are applied by this plugin.

const rule = {
  meta: {
    type: "problem",
    schema: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["selector", "message"],
        properties: {
          selector: { type: "string", minLength: 1 },
          message: { type: "string", minLength: 1 },
        },
      },
    },
  },
  create(context) {
    const visitors = {}
    for (const option of context.options) {
      visitors[option.selector] = (node) => {
        context.report({ node, message: option.message })
      }
    }
    return visitors
  },
}

const plugin = {
  meta: { name: "memory-residency" },
  rules: { "no-restricted-syntax": rule },
}

export default plugin
