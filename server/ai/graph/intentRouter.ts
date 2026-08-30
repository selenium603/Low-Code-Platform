import { shouldPlanLargeEdit } from '../../largeEditPlan'
import type { PageEditIntent } from './pageEditState'

const EDIT_ACTION = /修改|调整|替换|移动|新增|添加|创建|删除|移除|去掉|重构|重新设计|重新布局|重排|排版|布局|美化|优化|统一|改成|改为|换成|变成|变为|设置|放大|缩小|加宽|变窄|上移|下移|左移|右移/i
const IMPERATIVE_CHANGE = /(?:把|将).{0,40}(?:改|变)/i
const QUESTION = /[?？]|为什么|是什么|怎么|如何|能否|可以吗|有没有|是否/i
const FULL_SCOPE = /全部|所有|整页|全局|整体|整个页面|全部组件/i
const LAYOUT_TARGET = /布局|排版|结构|分区|组件位置|页面层级/i
const RELAYOUT_ACTION = /重构|重新设计|重新布局|重排|排版|布局调整|优化|美化|调整/i
const STRONG_RELAYOUT_ACTION = /重构|重新设计|重新布局|重排/i
const LOCAL_TARGET = /标题|主标题|副标题|正文|文本|文案|按钮|图片|图像|输入框|表单|图表|背景|颜色|字体|字号|组件|模块|卡片/i
const LOCAL_PROPERTY = /颜色|字体|字号|文案|内容|位置|宽度|高度|尺寸|圆角|边框|间距|透明度|对齐|链接|占位符/i

const isFullRelayout = (request: string) => (
  FULL_SCOPE.test(request)
  && (STRONG_RELAYOUT_ACTION.test(request) || (LAYOUT_TARGET.test(request) && RELAYOUT_ACTION.test(request)))
)

const hasEditAction = (request: string) => EDIT_ACTION.test(request) || IMPERATIVE_CHANGE.test(request)

export const classifyPageEditIntent = (request: string, componentCount: number): PageEditIntent => {
  const normalized = request.trim()
  if (isFullRelayout(normalized)) return 'full_relayout'
  if (shouldPlanLargeEdit(normalized, componentCount)) return 'large_edit'
  if (QUESTION.test(normalized) && !hasEditAction(normalized)) return 'question'
  if (LOCAL_TARGET.test(normalized) && (hasEditAction(normalized) || LOCAL_PROPERTY.test(normalized) || /改|变/.test(normalized))) {
    return 'local_edit'
  }
  return 'unresolved'
}
