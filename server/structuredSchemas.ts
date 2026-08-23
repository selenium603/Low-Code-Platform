type JsonSchema = Record<string, unknown>

const nullable = (schema: JsonSchema): JsonSchema => ({ anyOf: [schema, { type: 'null' }] })
const string = { type: 'string' }
const number = { type: 'number' }
const integer = { type: 'integer' }
const boolean = { type: 'boolean' }
const enumString = (values: string[]) => ({ type: 'string', enum: values })
const object = (properties: Record<string, JsonSchema>, required = Object.keys(properties)): JsonSchema => ({
  type: 'object',
  additionalProperties: false,
  required,
  properties
})
const array = (items: JsonSchema, options: Record<string, unknown> = {}): JsonSchema => ({ type: 'array', items, ...options })

const styleProperties = {
  top: number,
  left: number,
  width: number,
  height: number,
  zIndex: number,
  rotate: number,
  opacity: number,
  fontSize: nullable(number),
  fontWeight: nullable(number),
  lineHeight: nullable(number),
  color: nullable(string),
  backgroundColor: nullable(string),
  borderWidth: nullable(number),
  borderColor: nullable(string),
  borderRadius: nullable(number),
  textAlign: nullable(enumString(['left', 'center', 'right']))
}

const componentStyleSchema = object(styleProperties)
const mobileStyleSchema = object({ ...styleProperties })
const addStyleSchema = object({
  left: number,
  top: number,
  width: number,
  height: number,
  rotate: nullable(number),
  opacity: nullable(number),
  fontSize: nullable(number),
  fontWeight: nullable(number),
  lineHeight: nullable(number),
  color: nullable(string),
  backgroundColor: nullable(string),
  borderWidth: nullable(number),
  borderColor: nullable(string),
  borderRadius: nullable(number),
  textAlign: nullable(enumString(['left', 'center', 'right']))
})

const formFieldSchema = object({
  id: string,
  label: string,
  type: enumString(['text', 'email', 'tel']),
  placeholder: string,
  required: boolean
})
const chartDataSchema = object({ name: string, value: number })

const componentPropsProperties: Record<string, Record<string, JsonSchema>> = {
  Text: { content: { type: 'string', maxLength: 5000 } },
  Image: { src: string, alt: { type: 'string', maxLength: 500 }, objectFit: enumString(['cover', 'contain', 'fill']) },
  Button: { content: { type: 'string', maxLength: 500 }, type: enumString(['primary', 'success', 'warning', 'danger', 'info']) },
  Input: { placeholder: { type: 'string', maxLength: 500 }, value: { type: 'string', maxLength: 2000 }, inputType: enumString(['text', 'email', 'tel', 'number']) },
  Form: { title: { type: 'string', maxLength: 500 }, submitText: { type: 'string', maxLength: 200 }, fields: array(formFieldSchema) },
  Chart: {
    chartType: enumString(['bar', 'line', 'pie']),
    title: { type: 'string', maxLength: 500 },
    data: array(chartDataSchema),
    showLegend: boolean,
    legendPosition: enumString(['top', 'bottom', 'right']),
    showXAxis: boolean,
    showYAxis: boolean,
    xAxisName: string,
    yAxisName: string,
    valueUnit: string,
    primaryColor: string,
    secondaryColor: string,
    accentColor: string,
    tooltipFormat: enumString(['name-value', 'value', 'percent'])
  }
}
const componentPropsSchemas: Record<string, JsonSchema> = Object.fromEntries(
  Object.entries(componentPropsProperties).map(([type, properties]) => [type, object(properties)])
)

const clickEventSchema = object({
  type: { type: 'string', enum: ['click'] },
  config: object({
    action: enumString(['none', 'url', 'message']),
    url: nullable(string),
    message: nullable(string),
    newTab: nullable(boolean)
  })
})

const componentSchema = (componentType: string) => object({
  id: string,
  type: { type: 'string', enum: [componentType] },
  name: string,
  schemaVersion: { type: 'string', enum: ['2026.05'] },
  style: componentStyleSchema,
  responsiveOverrides: object({ mobile: mobileStyleSchema }),
  props: componentPropsSchemas[componentType]!,
  events: array(clickEventSchema, { minItems: 1, maxItems: 1 })
})

export const pageDataSchema: JsonSchema = object({
  id: string,
  meta: object({
    title: string,
    description: string,
    createdAt: string,
    updatedAt: string,
    version: { type: 'string', enum: ['2026.05'] },
    scene: enumString(['marketing', 'landing', 'form'])
  }),
  style: object({
    width: { type: 'number', const: 1200 },
    height: { type: 'number', const: 820 },
    backgroundColor: string,
    backgroundImage: nullable(string)
  }),
  responsiveOverrides: object({
    mobile: object({
      width: { type: 'number', const: 375 },
      height: number,
      backgroundColor: string,
      backgroundImage: nullable(string)
    })
  }),
  components: array({
    anyOf: ['Text', 'Image', 'Button', 'Input', 'Form', 'Chart'].map(componentSchema)
  }, { minItems: 1, maxItems: 12 })
})

const nullablePartialProps = (componentType: string) => object(Object.fromEntries(
  Object.entries(componentPropsProperties[componentType] || {}).map(([key, schema]) => [key, nullable(schema)])
))

const nullableStyleChanges = object(Object.fromEntries(
  Object.entries(styleProperties).map(([key, schema]) => {
    const candidate = schema as JsonSchema
    return [key, 'anyOf' in candidate ? candidate : nullable(candidate)]
  })
))
const nullablePageStyleChanges = object({
  width: nullable(number),
  height: nullable(number),
  backgroundColor: nullable(string),
  backgroundImage: nullable(string)
})

const updatePropsOperation = (componentType: string, componentIds: string[]) => object({
  op: { type: 'string', enum: ['updateProps'] },
  componentId: enumString(componentIds),
  changes: nullablePartialProps(componentType)
})
const updateStyleOperation = (componentIds: string[]) => object({
  op: { type: 'string', enum: ['updateStyle'] },
  componentId: enumString(componentIds),
  device: enumString(['desktop', 'mobile']),
  changes: nullableStyleChanges
})
const updatePageStyleOperation = object({
  op: { type: 'string', enum: ['updatePageStyle'] },
  device: enumString(['desktop', 'mobile']),
  changes: nullablePageStyleChanges
})
const placeRelativeOperation = (componentIds: string[]) => object({
  op: { type: 'string', enum: ['placeRelative'] },
  componentId: enumString(componentIds),
  targetId: enumString(componentIds),
  device: enumString(['desktop', 'mobile']),
  relation: enumString(['above', 'below', 'left', 'right']),
  gap: number,
  align: enumString(['start', 'center', 'end'])
})
const removeComponentOperation = (componentIds: string[]) => object({
  op: { type: 'string', enum: ['removeComponent'] },
  componentId: enumString(componentIds)
})
const moveLayerOperation = (componentIds: string[]) => object({
  op: { type: 'string', enum: ['moveLayer'] },
  componentId: enumString(componentIds),
  direction: enumString(['up', 'down', 'top', 'bottom'])
})
const addComponentOperation = (componentType: string) => object({
  op: { type: 'string', enum: ['addComponent'] },
  componentType: { type: 'string', enum: [componentType] },
  name: string,
  props: componentPropsSchemas[componentType]!,
  style: addStyleSchema,
  mobileStyle: addStyleSchema
})

type EditableComponent = { id: string; type: string }
type EditSchemaOptions = {
  baseRevision: number
  operationLimit: number
  allowedComponentIds?: Set<string>
  allowedOperationKinds?: Set<string>
}

/**
 * Patch Schema 必须结合本轮页面动态创建：updateProps 按真实组件类型分支，
 * componentId/targetId 也只能从当前允许修改的稳定 ID 中选择。
 */
export const createEditResponseSchema = (
  components: EditableComponent[],
  options: EditSchemaOptions
): JsonSchema => {
  const knownTypes = new Set(Object.keys(componentPropsProperties))
  const editable = components.filter((component) => (
    Boolean(component.id)
    && knownTypes.has(component.type)
    && (!options.allowedComponentIds || options.allowedComponentIds.has(component.id))
  ))
  const componentIds = [...new Set(editable.map((component) => component.id))]
  const idsByType = new Map<string, string[]>()
  editable.forEach((component) => {
    const ids = idsByType.get(component.type) || []
    ids.push(component.id)
    idsByType.set(component.type, ids)
  })
  const allows = (kind: string) => !options.allowedOperationKinds || options.allowedOperationKinds.has(kind)
  const operations: JsonSchema[] = []

  if (allows('updateProps')) {
    idsByType.forEach((ids, type) => operations.push(updatePropsOperation(type, [...new Set(ids)])))
  }
  if (componentIds.length && allows('updateStyle')) operations.push(updateStyleOperation(componentIds))
  if (allows('updatePageStyle')) operations.push(updatePageStyleOperation)
  if (componentIds.length && allows('placeRelative')) operations.push(placeRelativeOperation(componentIds))
  if (allows('addComponent')) {
    operations.push(...Object.keys(componentPropsProperties).map(addComponentOperation))
  }
  if (componentIds.length && allows('removeComponent')) operations.push(removeComponentOperation(componentIds))
  if (componentIds.length && allows('moveLayer')) operations.push(moveLayerOperation(componentIds))

  if (!operations.length) {
    return object({
      type: { type: 'string', enum: ['need_clarification'] },
      question: { type: 'string', maxLength: 500 },
      baseRevision: { type: 'null' },
      summary: { type: 'null' },
      operations: { type: 'null' }
    })
  }

  // 根节点保持单一 object，避免部分 Structured Output 提供商拒绝 root oneOf。
  return object({
    type: enumString(['page_patch', 'need_clarification']),
    question: nullable({ type: 'string', maxLength: 500 }),
    baseRevision: nullable({ type: 'integer', const: options.baseRevision }),
    summary: nullable({ type: 'string', maxLength: 300 }),
    operations: nullable(array({ anyOf: operations }, {
      minItems: 1,
      maxItems: Math.max(1, Math.min(12, options.operationLimit))
    }))
  })
}

const rectSchema = object({ left: number, top: number, width: number, height: number })
export const layoutPlanSchema: JsonSchema = object({
  concept: string,
  palette: object({ background: string, surface: string, primary: string, text: string, muted: string }),
  layout: string,
  mobile: object({ strategy: { type: 'string', enum: ['single-column'] }, gap: number, order: array(string) }),
  sections: array(object({ role: string, bounds: rectSchema }), { minItems: 1, maxItems: 8 }),
  components: array(object({
    type: enumString(['Text', 'Image', 'Button', 'Input', 'Form', 'Chart']),
    role: string,
    section: string,
    bounds: rectSchema,
    mobileOrder: integer,
    mobileHeight: number,
    priority: integer
  }), { minItems: 4, maxItems: 6 })
})

export const componentLocatorSchema: JsonSchema = object({
  type: enumString(['selection', 'need_clarification']),
  scope: nullable(enumString(['components', 'page'])),
  componentIds: nullable(array(string, { maxItems: 12 })),
  reason: nullable(string),
  question: nullable(string)
})

export const largeEditResponseSchema: JsonSchema = object({
  type: enumString(['page_edit_plan', 'need_clarification']),
  summary: nullable(string),
  steps: nullable(array(object({
    id: string,
    title: string,
    instruction: string,
    scope: enumString(['page', 'components']),
    operationBudget: integer
  }), { minItems: 2, maxItems: 6 })),
  question: nullable(string)
})

export const strictResponseFormat = (name: string, schema: JsonSchema) => ({
  type: 'json_schema',
  json_schema: { name, strict: true, schema }
})

/** strict 用 null 表示可选字段；进入现有校验链前恢复为原来的稀疏对象。 */
export const compactStructuredValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(compactStructuredValue)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, candidate]) => candidate !== null)
      .map(([key, candidate]) => [key, compactStructuredValue(candidate)])
  )
}
