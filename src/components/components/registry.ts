import { ComponentType } from '@/types'
import TextComponent from './TextComponent.vue'
import ImageComponent from './ImageComponent.vue'
import ButtonComponent from './ButtonComponent.vue'
import InputComponent from './InputComponent.vue'
import FormComponent from './FormComponent.vue'
import ChartComponent from './ChartComponent.vue'

export { componentProtocols, getComponentProtocol } from '@/domain/componentProtocols'

export const componentRendererMap = {
  [ComponentType.TEXT]: TextComponent,
  [ComponentType.IMAGE]: ImageComponent,
  [ComponentType.BUTTON]: ButtonComponent,
  [ComponentType.INPUT]: InputComponent,
  [ComponentType.FORM]: FormComponent,
  [ComponentType.CHART]: ChartComponent
}
