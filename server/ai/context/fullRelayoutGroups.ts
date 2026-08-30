import type { PageData } from '../../../src/types'

export interface FullRelayoutGroup {
  index: number
  componentIds: string[]
  estimatedOperations: number
}

/** 按桌面空间顺序稳定枚举，并按操作预算连续切分，避免模型遗漏或重复召回组件。 */
export const createFullRelayoutGroups = (
  page: PageData,
  options: { operationBudget?: number; estimatedOperationsPerComponent?: number } = {}
): FullRelayoutGroup[] => {
  const operationBudget = Math.max(1, Math.min(8, Math.floor(options.operationBudget ?? 8)))
  const perComponent = Math.max(1, Math.min(operationBudget, Math.floor(options.estimatedOperationsPerComponent ?? 2)))
  const orderedIds = [...page.components]
    .sort((first, second) => (
      first.style.top - second.style.top
      || first.style.left - second.style.left
      || first.id.localeCompare(second.id)
    ))
    .map((component) => component.id)
  const componentBudget = Math.max(1, Math.floor(operationBudget / perComponent))

  return Array.from({ length: Math.ceil(orderedIds.length / componentBudget) }, (_, index) => {
    const componentIds = orderedIds.slice(index * componentBudget, (index + 1) * componentBudget)
    return { index, componentIds, estimatedOperations: componentIds.length * perComponent }
  })
}
