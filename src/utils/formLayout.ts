/** 与 FormComponent.vue 当前视觉结构保持一致的尺寸常量。 */
const FORM_VERTICAL_PADDING = 40
const FORM_SECTION_GAPS = 32
const FORM_TITLE_HEIGHT = 26
const FORM_SUBMIT_HEIGHT = 40
const FORM_FIELD_HEIGHT = 62
const FORM_FIELD_GAP = 12
const EMPTY_FIELDS_MIN_HEIGHT = 140

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
)

export const getFormFieldCount = (props: unknown) => {
  if (!isRecord(props) || !Array.isArray(props.fields)) return 0
  return props.fields.length
}

/**
 * 表单最小高度随字段数量变化。删除字段只会降低允许的下限；调用方不应
 * 强制缩小用户已经设置的高度。新增字段且空间不足时则应自动扩高。
 */
export const getFormMinimumHeight = (props: unknown) => {
  const fieldCount = getFormFieldCount(props)
  if (fieldCount === 0) return EMPTY_FIELDS_MIN_HEIGHT
  const contentHeight = FORM_VERTICAL_PADDING
    + FORM_SECTION_GAPS
    + FORM_TITLE_HEIGHT
    + FORM_SUBMIT_HEIGHT
    + fieldCount * FORM_FIELD_HEIGHT
    + Math.max(0, fieldCount - 1) * FORM_FIELD_GAP
  return Math.ceil(contentHeight / 4) * 4
}
