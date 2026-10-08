import { expect, test } from "bun:test"
import Ajv2020 from "ajv/dist/2020"
import { z } from "zod"
import { ConfigExtensions } from "../../src/config/extensions"
import { ConfigDomain } from "../../src/config/domain"
import { RuntimeContext } from "../../src/lifecycle/context"
import { testRuntime } from "../support/runtime"
import { runtimeHome } from "../support/runtime-home"

test("an early config field projection retains owner metadata after registration", async () => {
  await using runtime = await testRuntime({
    composition: {
      register() {
        const field = ConfigExtensions.field("fixtureDocumentedField")
        expect(field.safeParse(undefined).success).toBe(true)
        expect(field.safeParse(true).success).toBe(false)
        ConfigExtensions.register("fixture-documented-field", {
          shape: { fixtureDocumentedField: z.boolean().optional().describe("Owner supplied behavior contract") },
        })
        expect(field.safeParse(true).success).toBe(true)
        expect(field.safeParse(undefined).success).toBe(true)
        expect(z.toJSONSchema(field)).toMatchObject({
          type: "boolean",
          description: "Owner supplied behavior contract",
        })
      },
    },
  })
})

test("dynamic schemas convert optional wrappers without requiring a new instance", () => {
  const owner = z.boolean().optional()
  const field = ConfigExtensions.dynamicSchema(() => owner)
  expect(field.safeParse(true).success).toBe(true)
  expect(field.safeParse(undefined).success).toBe(true)
  expect(field.safeParse("invalid").success).toBe(false)
  expect(z.toJSONSchema(field)).toMatchObject({ type: "boolean" })
  expect(z.toJSONSchema(z.object({ field }))).toMatchObject({
    type: "object",
    properties: { field: { type: "boolean" } },
  })
})

test("one early field projection resolves owner metadata independently in each runtime", async () => {
  const field = ConfigExtensions.field("fixtureRuntimeField")
  const container = z.object({ field })
  for (const owner of [z.boolean().describe("Boolean runtime owner"), z.string().describe("String runtime owner")]) {
    await using runtime = await testRuntime({
      composition: {
        register() {
          expect(field.safeParse(undefined).success).toBe(true)
          expect(field.safeParse(true).success).toBe(false)
          ConfigExtensions.register("fixture-runtime-field", { shape: { fixtureRuntimeField: owner.optional() } })
          const expected = z.toJSONSchema(owner)
          expect(z.toJSONSchema(field)).toMatchObject({ type: expected.type, description: expected.description })
          expect(z.toJSONSchema(container)).toMatchObject({
            properties: { field: { type: expected.type, description: expected.description } },
          })
          expect(field.safeParse(owner.type === "boolean" ? true : "value").success).toBe(true)
          expect(field.safeParse(owner.type === "boolean" ? "invalid" : true).success).toBe(false)
        },
      },
    })
  }
})

test("dynamic schema conversion preserves facade metadata, reuse and recursive references", () => {
  const owner = z.object({ value: z.string() }).meta({ id: "FixtureDynamicOwner" })
  const facade = ConfigExtensions.dynamicSchema(() => owner)
  z.globalRegistry.add(facade, { description: "Facade contract", ref: "FixtureDynamicFacade" })
  const check = (schema: z.core.JSONSchema.BaseSchema) => {
    expect(schema.description).toBe("Facade contract")
    expect(schema.ref).toBe("FixtureDynamicFacade")
    expect(JSON.stringify(schema)).toContain('"value"')
  }
  check(z.toJSONSchema(facade))
  check(z.core.toJSONSchema(facade))
  const instanceMethod = Reflect.get(facade, "toJSONSchema")
  if (typeof instanceMethod === "function") check(instanceMethod())
  const standard = Reflect.get(facade["~standard"], "jsonSchema")
  if (standard) {
    check(standard.input({ target: "draft-2020-12" }))
    check(standard.output({ target: "draft-2020-12" }))
  }
  const reused = z.toJSONSchema(z.object({ first: facade, second: facade }), { reused: "ref" })
  const validateReused = new Ajv2020({ strict: false }).compile(reused)
  expect(validateReused({ first: { value: "a" }, second: { value: "b" } })).toBe(true)
  expect(validateReused({ first: { value: "a" }, second: { value: 1 } })).toBe(false)
  expect(facade["~standard"].validate({ value: "valid" })).toEqual({ value: { value: "valid" } })
  expect(facade["~standard"].validate({ value: 1 })).toHaveProperty("issues")
  expect(Object.getOwnPropertyDescriptor(facade, "_zod")?.value).toBe(facade._zod)
  expect(facade.shape.value.safeParse("valid").success).toBe(true)
  expect(facade.pick({ value: true }).safeParse({ value: 1 }).success).toBe(false)
  const recursive: z.ZodType = z.object({
    value: z.string(),
    get children() {
      return recursiveFacade.array().optional()
    },
  })
  const recursiveFacade = ConfigExtensions.dynamicSchema(() => recursive)
  const converted = z.toJSONSchema(recursiveFacade)
  const validateRecursive = new Ajv2020({ strict: false }).compile(converted)
  expect(validateRecursive({ value: "root", children: [{ value: "child" }] })).toBe(true)
  expect(validateRecursive({ value: "root", children: [{ value: 1 }] })).toBe(false)
  expect(JSON.stringify(converted)).toContain('"$ref"')
  expect(recursiveFacade.safeParse({ value: "root", children: [{ value: "child" }] }).success).toBe(true)
  expect(() => z.toJSONSchema(recursiveFacade, { cycles: "throw" })).toThrow(/Cycle detected/)
})

test("field and domain projections remain stable per generation and independent across live runtimes", async () => {
  const field = ConfigExtensions.field("fixtureLiveField")
  const container = z.object({ field })
  await using home = await runtimeHome()
  const context = RuntimeContext.create(home.host)
  try {
    context.run(() => {
      const absent = field._zod
      expect(field._zod).toBe(absent)
      ConfigExtensions.register("fixture-live-field", {
        shape: { fixtureLiveField: z.boolean().meta({ id: "FixtureLiveOwner", description: "Owner contract" }) },
      })
      expect(field._zod).not.toBe(absent)
      expect(field._zod).toBe(field._zod)
      expect(z.toJSONSchema(container).$defs?.FixtureLiveOwner).toMatchObject({ type: "boolean" })
      const initial = ConfigDomain.Id._zod
      expect(ConfigDomain.Id._zod).toBe(initial)
      ConfigDomain.register({
        id: "fixture-live-domain",
        filename: "200-fixture.jsonc",
        label: "Fixture",
        ownedKeys: [],
        mergePolicy: "merge",
        reloadTargets: [],
        uiSection: "fixture",
        importable: true,
      })
      expect(ConfigDomain.Id._zod).not.toBe(initial)
      expect(ConfigDomain.Id.options).toContain("fixture-live-domain")
      expect(z.toJSONSchema(ConfigDomain.Id).enum).toContain("fixture-live-domain")
    })
  } finally {
    context.dispose()
  }
  await using booleanRuntime = await testRuntime({
    composition: {
      register() {
        ConfigExtensions.register("fixture-live-field", {
          shape: { fixtureLiveField: z.boolean().optional().describe("Boolean live owner") },
        })
      },
    },
  })
  await using stringRuntime = await testRuntime({
    composition: {
      register() {
        ConfigExtensions.register("fixture-live-field", {
          shape: { fixtureLiveField: z.string().optional().describe("String live owner") },
        })
      },
    },
  })
  const [instanceConverter, standardConverters] = booleanRuntime.run(() => [
    Reflect.get(field, "toJSONSchema"),
    Reflect.get(field["~standard"], "jsonSchema"),
  ])
  for (const [runtime, type, description, valid, invalid] of [
    [booleanRuntime, "boolean", "Boolean live owner", true, "invalid"],
    [stringRuntime, "string", "String live owner", "valid", true],
    [booleanRuntime, "boolean", "Boolean live owner", true, "invalid"],
  ] as const) {
    runtime.run(() => {
      expect(z.toJSONSchema(container)).toMatchObject({ properties: { field: { type, description } } })
      if (typeof instanceConverter === "function") expect(instanceConverter()).toMatchObject({ type, description })
      if (standardConverters) {
        expect(standardConverters.input({ target: "draft-2020-12" })).toMatchObject({ type, description })
        expect(standardConverters.output({ target: "draft-2020-12" })).toMatchObject({ type, description })
      }
      expect(field.safeParse(valid).success).toBe(true)
      expect(field.safeParse(invalid).success).toBe(false)
      expect(field._zod).toBe(field._zod)
      expect(ConfigDomain.Id.options).not.toContain("fixture-live-domain")
    })
  }
})
