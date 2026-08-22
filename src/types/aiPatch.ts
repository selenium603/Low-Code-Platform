import type { ComponentProps, ComponentStyle, PageData, PageStyle } from '@/types'
import type { ComponentType, DeviceType } from '@/types'

export type AIConversationRole = 'user' | 'assistant'

export interface AIConversationMessage {
  id: string
  role: AIConversationRole
  content: string
  createdAt: string
  patchSummary?: string
}

export interface AIConversationMemory {
  userGoals: string[]
  designConstraints: string[]
  completedChanges: string[]
  openQuestions: string[]
}

export interface AIConversationSession {
  pageId: string
  memory: AIConversationMemory
  recentMessages: AIConversationMessage[]
  pageRevision: number
  updatedAt: string
}

export type RelativePosition = 'above' | 'below' | 'left' | 'right'
export type RelativeAlign = 'start' | 'center' | 'end'

export type AIPageOperation =
  | {
      op: 'updateProps'
      componentId: string
      changes: Partial<ComponentProps> | Record<string, unknown>
    }
  | {
      op: 'updateStyle'
      componentId: string
      device: DeviceType
      changes: Partial<ComponentStyle>
    }
  | {
      op: 'updatePageStyle'
      device: DeviceType
      changes: Partial<PageStyle>
    }
  | {
      op: 'placeRelative'
      componentId: string
      targetId: string
      device: DeviceType
      relation: RelativePosition
      gap?: number
      align?: RelativeAlign
    }
  | {
      op: 'addComponent'
      componentType: ComponentType
      name?: string
      props?: Record<string, unknown>
      style?: Partial<ComponentStyle>
      mobileStyle?: Partial<ComponentStyle>
      device?: DeviceType
    }
  | {
      op: 'removeComponent'
      componentId: string
    }
  | {
      op: 'moveLayer'
      componentId: string
      direction: 'up' | 'down' | 'top' | 'bottom'
    }

export interface AIPagePatch {
  type: 'page_patch'
  baseRevision: number
  summary: string
  operations: AIPageOperation[]
}

export interface AIClarification {
  type: 'need_clarification'
  question: string
}

export interface AIPageEditPlanStep {
  id: string
  title: string
  instruction: string
  scope: 'page' | 'components'
  operationBudget: number
}

export interface AIPageEditPlan {
  type: 'page_edit_plan'
  planId: string
  summary: string
  steps: AIPageEditPlanStep[]
}

export interface AIEditExecutionContext {
  planId: string
  planSummary: string
  originalRequest: string
  stepIndex: number
  stepCount: number
  step: AIPageEditPlanStep
  validationError?: string
}

export type AIEditResponse = AIPagePatch | AIClarification | AIPageEditPlan

export interface AIEditRequest {
  message: string
  page: PageData
  baseRevision: number
  recentMessages: AIConversationMessage[]
  conversationMemory: AIConversationMemory
  execution?: AIEditExecutionContext
}
