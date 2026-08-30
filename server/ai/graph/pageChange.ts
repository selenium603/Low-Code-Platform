import type { PageData } from '../../../src/types'

const comparablePage = (page: PageData) => ({
  ...page,
  meta: {
    ...page.meta,
    updatedAt: ''
  }
})

/** 页面修改会固定刷新 updatedAt；有效变化判断只比较其余业务数据。 */
export const hasEffectivePageChange = (before: PageData, after: PageData) => (
  JSON.stringify(comparablePage(before)) !== JSON.stringify(comparablePage(after))
)
