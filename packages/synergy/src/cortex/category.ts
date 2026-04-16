import { Config } from "../config/config"
import { Provider } from "../provider/provider"
import { Log } from "../util/log"

export namespace Category {
  const log = Log.create({ service: "cortex.category" })

  export const CategoryConfig = Config.CategoryConfig
  export type CategoryConfig = Config.CategoryConfig

  const CATEGORY_ROLES: Record<string, Provider.ModelRole> = {
    "visual-engineering": "creative",
    ultrabrain: "thinking",
    artistry: "creative",
    quick: "mid",
    "most-capable": "thinking",
    writing: "creative",
    general: "mid",
  }

  const BUILTIN: Record<string, CategoryConfig> = {
    "visual-engineering": {
      temperature: 0.7,
      description: "Frontend, UI/UX, design, styling, animation",
      promptAppend: `<category-context>
You are working on VISUAL/UI tasks.

Design-first mindset:
- Bold aesthetic choices over safe defaults
- Unexpected layouts, asymmetry, grid-breaking elements
- Distinctive typography (avoid: Arial, Inter, Roboto, Space Grotesk)
- Cohesive color palettes with sharp accents
- High-impact animations with staggered reveals
- Atmosphere: gradient meshes, noise textures, layered transparencies

AVOID: Generic fonts, purple gradients on white, predictable layouts, cookie-cutter patterns.
</category-context>`,
    },

    ultrabrain: {
      temperature: 0.1,
      description: "Strict architecture design, very complex business logic",
      promptAppend: `<category-context>
You are working on BUSINESS LOGIC / ARCHITECTURE tasks.

Strategic advisor mindset:
- Bias toward simplicity: least complex solution that fulfills requirements
- Leverage existing code/patterns over new components
- Prioritize developer experience and maintainability
- One clear recommendation with effort estimate (Quick/Short/Medium/Large)
- Signal when advanced approach warranted

Response format:
- Bottom line (2-3 sentences)
- Action plan (numbered steps)
- Risks and mitigations (if relevant)
</category-context>`,
    },

    artistry: {
      temperature: 0.9,
      description: "Highly creative/artistic tasks, novel ideas",
      promptAppend: `<category-context>
You are working on HIGHLY CREATIVE / ARTISTIC tasks.

Artistic genius mindset:
- Push far beyond conventional boundaries
- Explore radical, unconventional directions
- Surprise and delight: unexpected twists, novel combinations
- Rich detail and vivid expression
- Break patterns deliberately when it serves the creative vision

Approach:
- Generate diverse, bold options first
- Embrace ambiguity and wild experimentation
- Balance novelty with coherence
- This is for tasks requiring exceptional creativity
</category-context>`,
    },

    quick: {
      temperature: 0.3,
      description: "Cheap & fast - small tasks with minimal overhead, budget-friendly",
      promptAppend: `<category-context>
You are working on SMALL / QUICK tasks.

Efficient execution mindset:
- Fast, focused, minimal overhead
- Get to the point immediately
- No over-engineering
- Simple solutions for simple problems

Approach:
- Minimal viable implementation
- Skip unnecessary abstractions
- Direct and concise
</category-context>

<caller-warning>
This category uses a less capable model.

The model executing this task has LIMITED reasoning capacity. Your prompt MUST be:

**EXHAUSTIVELY EXPLICIT** - Leave NOTHING to interpretation:
1. MUST DO: List every required action as atomic, numbered steps
2. MUST NOT DO: Explicitly forbid likely mistakes and deviations
3. EXPECTED OUTPUT: Describe exact success criteria with concrete examples

If your prompt lacks this structure, REWRITE IT before delegating.
</caller-warning>`,
    },

    "most-capable": {
      temperature: 0.1,
      description: "Complex tasks requiring maximum capability",
      promptAppend: `<category-context>
You are working on COMPLEX / MOST-CAPABLE tasks.

Maximum capability mindset:
- Bring full reasoning power to bear
- Consider all edge cases and implications
- Deep analysis before action
- Quality over speed

Approach:
- Thorough understanding first
- Comprehensive solution design
- Meticulous execution
- This is for the most challenging problems
</category-context>`,
    },

    writing: {
      temperature: 0.5,
      description: "Documentation, prose, technical writing",
      promptAppend: `<category-context>
You are working on WRITING / PROSE tasks.

Wordsmith mindset:
- Clear, flowing prose
- Appropriate tone and voice
- Engaging and readable
- Proper structure and organization

Approach:
- Understand the audience
- Draft with care
- Polish for clarity and impact
- Documentation, READMEs, articles, technical writing
</category-context>`,
    },

    general: {
      temperature: 0.3,
      description: "General purpose tasks",
      promptAppend: `<category-context>
You are working on GENERAL tasks.

Balanced execution mindset:
- Practical, straightforward approach
- Good enough is good enough
- Focus on getting things done

Approach:
- Standard best practices
- Reasonable trade-offs
- Efficient completion
</category-context>

<caller-warning>
This category uses a mid-tier model.

While capable, this model benefits significantly from EXPLICIT instructions.

**PROVIDE CLEAR STRUCTURE:**
1. MUST DO: Enumerate required actions explicitly - don't assume inference
2. MUST NOT DO: State forbidden actions to prevent scope creep or wrong approaches
3. EXPECTED OUTPUT: Define concrete success criteria and deliverables

The more explicit your prompt, the better the results.
</caller-warning>`,
    },
  }

  function resolveBuiltinModel(name: string, cfg: Config.Info): string | undefined {
    const role = CATEGORY_ROLES[name]
    if (!role) return undefined
    const ref = Provider.resolveRoleModelSync(cfg, role)
    return ref ? `${ref.providerID}/${ref.modelID}` : undefined
  }

  export async function resolve(name?: string): Promise<CategoryConfig | undefined> {
    if (!name || name === "none") {
      return undefined
    }

    const userConfig = await Config.get()
    const userCategories = userConfig.category ?? {}

    if (userCategories[name]) {
      log.info("using user category", { name })
      const base = BUILTIN[name]
      const merged = { ...base, ...userCategories[name] }
      if (!merged.model && base) {
        merged.model = resolveBuiltinModel(name, userConfig)
      }
      return merged
    }

    if (BUILTIN[name]) {
      log.info("using builtin category", { name })
      return {
        ...BUILTIN[name],
        model: resolveBuiltinModel(name, userConfig),
      }
    }

    log.warn("unknown category", { name })
    return undefined
  }

  export async function list(): Promise<string[]> {
    const userConfig = await Config.get()
    const userCategories = Object.keys(userConfig.category ?? {})
    const builtinCategories = Object.keys(BUILTIN)
    return [...new Set([...builtinCategories, ...userCategories])]
  }

  export function descriptions(): string {
    return Object.entries(BUILTIN)
      .map(([name, config]) => `  - \`${name}\`: ${config.description}`)
      .join("\n")
  }

  export function getBuiltin(): Record<string, CategoryConfig> {
    return { ...BUILTIN }
  }
}
