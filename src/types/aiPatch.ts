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

export interface AIConversationSession {
  pageId: string
  summary: string
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

export type AIEditResponse = AIPagePatch | AIClarification

export interface AIEditRequest {
  message: string
  page: PageData
  baseRevision: number
  recentMessages: AIConversationMessage[]
  conversationSummary: string
}
