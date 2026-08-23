<template>
  <el-dialog
    v-model="visible"
    title="AI 页面助手"
    width="700px"
    append-to-body
    draggable
    class="ai-dialog"
    :before-close="handleBeforeClose"
  >
    <div class="mode-row">
      <el-radio-group v-model="mode" size="small" :disabled="loading">
        <el-radio-button value="generate">生成新页面</el-radio-button>
        <el-radio-button value="edit" :disabled="!currentPage">继续修改</el-radio-button>
      </el-radio-group>
      <span class="revision">页面 revision：{{ editorStore.pageRevision }}</span>
    </div>

    <p class="hint">
      {{ mode === 'generate'
        ? '描述页面结构、内容和风格，AI 会生成可继续编辑的完整页面。'
        : '直接描述要修改的内容。AI 只返回增量操作，并保留你已经完成的其他编辑。' }}
    </p>

    <div ref="messagesRef" class="messages" :class="{ empty: messages.length === 0 }">
      <div v-if="messages.length === 0" class="empty-state">
        <strong>{{ mode === 'generate' ? '从一句需求开始生成' : '可以继续修改当前页面' }}</strong>
        <span>{{ mode === 'generate' ? '例如：生成一个春季商品营销页，包含主视觉、卖点、报名表单和 CTA。' : '例如：把主标题改成深红色，并将按钮放到表单下面。' }}</span>
      </div>
      <div
        v-for="message in messages"
        v-else
        :key="message.id"
        class="message"
        :class="message.role"
      >
        <div class="message-role">{{ message.role === 'user' ? '你' : 'AI' }}</div>
        <div class="message-bubble">
          {{ message.content }}
          <small v-if="message.patchSummary">{{ message.patchSummary }}</small>
        </div>
      </div>
    </div>

    <el-input
      v-model="prompt"
      type="textarea"
      :rows="4"
      maxlength="1000"
      show-word-limit
      :disabled="loading"
      :placeholder="mode === 'generate'
        ? '描述页面结构、内容和视觉风格'
        : '说明要修改的组件、内容、位置或设备，例如：手机端按钮改成满宽'"
      @keydown.ctrl.enter.prevent="submit"
      @keydown.meta.enter.prevent="submit"
    />

    <div v-if="loading" class="progress">
      <el-icon class="is-loading"><Loading /></el-icon>
      <span>{{ progressText }}</span>
    </div>
    <el-alert v-else-if="errorMessage" type="error" :closable="false" show-icon :title="errorMessage" />

    <template #footer>
      <div class="dialog-footer">
        <div class="footer-tools">
          <el-button text :disabled="loading || messages.length === 0" @click="clearConversation">清空对话</el-button>
          <el-button text :disabled="loading || !canUndoAI" @click="undoLastAIChange">撤销本次 AI 修改</el-button>
        </div>
        <div>
          <el-button @click="requestClose">关闭</el-button>
          <el-button type="primary" :loading="loading" @click="submit">
            {{ mode === 'generate' ? '生成并载入画布' : '发送修改' }}
          </el-button>
        </div>
      </div>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, shallowRef, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Loading } from '@element-plus/icons-vue'
import { generatePageFromPrompt } from '@/services/aiPage'
import { editPageFromPrompt } from '@/services/aiEditPage'
import { applyAIPagePatch } from '@/services/pagePatchExecutor'
import { useEditorStore } from '@/stores/editor'
import { useHistoryStore } from '@/stores/history'
import { useAIConversationStore } from '@/stores/aiConversation'
import { DeviceType } from '@/types'

const visible = defineModel<boolean>('visible', { required: true })
const prompt = ref('')
const mode = ref<'generate' | 'edit'>('generate')
const loading = ref(false)
const progressText = ref('')
const errorMessage = ref('')
const messagesRef = ref<HTMLElement | null>(null)
const activeRequest = shallowRef<AbortController | null>(null)
const closeConfirming = ref(false)
let pendingCloseDecision: Promise<boolean> | null = null

const editorStore = useEditorStore()
const historyStore = useHistoryStore()
const conversationStore = useAIConversationStore()
conversationStore.load()

const currentPage = computed(() => editorStore.currentPage)
const currentSession = computed(() => {
  const page = currentPage.value
  return page ? conversationStore.getSession(page.id, editorStore.pageRevision) : null
})
const messages = computed(() => currentSession.value?.recentMessages || [])
const canUndoAI = computed(() => {
  const last = historyStore.undoStack[historyStore.undoStack.length - 1]
  return Boolean(last?.label?.startsWith('AI 修改：'))
})

const scrollToLatest = async () => {
  await nextTick()
  if (messagesRef.value) messagesRef.value.scrollTop = messagesRef.value.scrollHeight
}

watch(visible, (opened) => {
  if (!opened) return
  errorMessage.value = ''
  const page = currentPage.value
  if (page) {
    const session = conversationStore.getSession(page.id, editorStore.pageRevision)
    conversationStore.syncRevision(page.id, editorStore.pageRevision)
    mode.value = session.recentMessages.length > 0 ? 'edit' : 'generate'
  }
  scrollToLatest()
})

watch(() => messages.value.length, scrollToLatest)

const throwIfAborted = (signal: AbortSignal) => {
  if (signal.aborted) throw new DOMException('AI 请求已取消。', 'AbortError')
}

const isAbortError = (error: unknown) => (
  error instanceof DOMException && error.name === 'AbortError'
) || (error instanceof Error && error.name === 'AbortError')

const waitForCloseDecision = async () => {
  const decision = pendingCloseDecision
  if (decision) await decision
}

const generate = async (message: string, signal: AbortSignal) => {
  progressText.value = '正在启动两阶段页面生成…'
  const result = await generatePageFromPrompt(message, (progress) => { progressText.value = progress }, signal)
  await waitForCloseDecision()
  throwIfAborted(signal)
  progressText.value = '正在校验组件与属性，并载入编辑画布…'
  editorStore.setDevice(DeviceType.DESKTOP)
  const { warnings, componentCount } = editorStore.importGeneratedPage(result.page)
  historyStore.clearHistory()
  editorStore.persistPage()

  const page = editorStore.currentPage
  if (page) {
    conversationStore.clearSession(page.id, editorStore.pageRevision)
    conversationStore.appendMessage(page.id, editorStore.pageRevision, 'user', message)
    conversationStore.appendMessage(
      page.id,
      editorStore.pageRevision,
      'assistant',
      `已生成并载入 ${componentCount} 个可编辑组件。你可以继续告诉我需要修改什么。`,
      warnings.length ? `自动修复 ${warnings.length} 项数据；生成尝试 ${result.attempts} 次。` : `生成尝试 ${result.attempts} 次。`
    )
    conversationStore.rememberUserIntent(page.id, editorStore.pageRevision, message)
    conversationStore.rememberCompletedChange(page.id, editorStore.pageRevision, `生成并载入 ${componentCount} 个可编辑组件`)
  }
  mode.value = 'edit'
  ElMessage.success(`页面生成完成，已载入 ${componentCount} 个组件。`)
}

const edit = async (message: string, signal: AbortSignal) => {
  const page = currentPage.value
  if (!page) throw new Error('当前没有可修改的页面，请先生成或新建页面。')
  const baseRevision = editorStore.pageRevision
  const session = conversationStore.getSession(page.id, baseRevision)
  const requestMessages = JSON.parse(JSON.stringify(session.recentMessages))
  const requestMemory = JSON.parse(JSON.stringify(session.memory))
  const pendingMessage = conversationStore.appendMessage(page.id, baseRevision, 'user', message)
  progressText.value = '正在读取当前页面和最近对话…'

  let response: Awaited<ReturnType<typeof editPageFromPrompt>>
  try {
    response = await editPageFromPrompt({
      message,
      page: JSON.parse(JSON.stringify(page)),
      baseRevision,
      recentMessages: requestMessages,
      conversationMemory: requestMemory
    }, (progress) => { progressText.value = progress }, signal)
  } catch (error) {
    if (isAbortError(error)) conversationStore.removeMessage(page.id, pendingMessage.id)
    throw error
  }

  await waitForCloseDecision()
  if (signal.aborted) {
    conversationStore.removeMessage(page.id, pendingMessage.id)
    throwIfAborted(signal)
  }

  if (editorStore.pageRevision !== baseRevision) {
    throw new Error('AI 处理期间页面已发生修改。为避免覆盖手工操作，请重新发送这条要求。')
  }

  if (response.result.type === 'need_clarification') {
    conversationStore.appendMessage(page.id, baseRevision, 'assistant', response.result.question)
    conversationStore.rememberUserIntent(page.id, baseRevision, message)
    conversationStore.rememberOpenQuestion(page.id, baseRevision, response.result.question)
    return
  }

  let nextPage = JSON.parse(JSON.stringify(page)) as typeof page
  let summary = ''
  let operationCount = 0
  let stepCount = 1
  const allWarnings: string[] = []

  if (response.result.type === 'page_edit_plan') {
    const plan = response.result
    stepCount = plan.steps.length
    for (let index = 0; index < plan.steps.length; index += 1) {
      const step = plan.steps[index]
      if (!step) continue
      let validationError = ''
      let stepApplied = false
      for (let applicationAttempt = 1; applicationAttempt <= 2; applicationAttempt += 1) {
        throwIfAborted(signal)
        if (editorStore.pageRevision !== baseRevision) {
          throw new Error('AI 处理期间页面已发生修改。为避免覆盖手工操作，请重新发送这条要求。')
        }
        progressText.value = `正在执行大幅修改 ${index + 1}/${plan.steps.length}：${step.title}${applicationAttempt > 1 ? '（修正布局）' : ''}`
        let stepResponse: Awaited<ReturnType<typeof editPageFromPrompt>>
        try {
          stepResponse = await editPageFromPrompt({
            message: step.instruction,
            page: JSON.parse(JSON.stringify(nextPage)),
            baseRevision,
            recentMessages: requestMessages,
            conversationMemory: requestMemory,
            execution: {
              planId: plan.planId,
              planSummary: plan.summary,
              originalRequest: message,
              stepIndex: index,
              stepCount: plan.steps.length,
              step,
              ...(validationError ? { validationError } : {})
            }
          }, (progress) => {
            progressText.value = `步骤 ${index + 1}/${plan.steps.length}：${progress}`
          }, signal)
        } catch (error) {
          if (isAbortError(error)) conversationStore.removeMessage(page.id, pendingMessage.id)
          throw error
        }
        await waitForCloseDecision()
        if (signal.aborted) {
          conversationStore.removeMessage(page.id, pendingMessage.id)
          throwIfAborted(signal)
        }
        if (stepResponse.result.type === 'need_clarification') {
          conversationStore.appendMessage(page.id, baseRevision, 'assistant', stepResponse.result.question)
          conversationStore.rememberUserIntent(page.id, baseRevision, message)
          conversationStore.rememberOpenQuestion(page.id, baseRevision, stepResponse.result.question)
          return
        }
        if (stepResponse.result.type === 'page_edit_plan') {
          throw new Error(`大幅修改第 ${index + 1} 步返回了重复计划，已取消整次修改。`)
        }
        try {
          const appliedStep = applyAIPagePatch(nextPage, stepResponse.result)
          nextPage = appliedStep.page
          operationCount += appliedStep.patch.operations.length
          allWarnings.push(...appliedStep.warnings)
          stepApplied = true
          break
        } catch (error) {
          validationError = error instanceof Error ? error.message : '页面副本校验失败'
          if (applicationAttempt === 2) {
            throw new Error(`大幅修改第 ${index + 1}/${plan.steps.length} 步“${step.title}”连续两次校验失败：${validationError}。真实页面未发生变化。`)
          }
        }
      }
      if (!stepApplied) throw new Error(`大幅修改第 ${index + 1} 步未能安全应用，真实页面未发生变化。`)
    }
    summary = plan.summary
  } else {
    let patch = response.result
    for (let applicationAttempt = 1; applicationAttempt <= 2; applicationAttempt += 1) {
      progressText.value = applicationAttempt === 1
        ? '正在校验并事务式应用增量修改…'
        : '正在校验 AI 修正后的增量修改…'
      try {
        const applied = applyAIPagePatch(nextPage, patch)
        nextPage = applied.page
        summary = applied.patch.summary
        operationCount = applied.patch.operations.length
        allWarnings.push(...applied.warnings)
        break
      } catch (error) {
        const validationError = error instanceof Error ? error.message : '页面副本校验失败'
        if (applicationAttempt === 2) {
          throw new Error(`AI 修改连续两次校验失败：${validationError}。真实页面未发生变化。`)
        }

        throwIfAborted(signal)
        if (editorStore.pageRevision !== baseRevision) {
          throw new Error('AI 处理期间页面已发生修改。为避免覆盖手工操作，请重新发送这条要求。')
        }
        progressText.value = `页面副本校验失败：${validationError} 正在要求 AI 修正 Patch…`
        let repairResponse: Awaited<ReturnType<typeof editPageFromPrompt>>
        try {
          repairResponse = await editPageFromPrompt({
            message,
            page: JSON.parse(JSON.stringify(page)),
            baseRevision,
            recentMessages: requestMessages,
            conversationMemory: requestMemory,
            repairContext: {
              validationError,
              previousPatch: patch
            }
          }, (progress) => { progressText.value = `正在修正布局：${progress}` }, signal)
        } catch (repairError) {
          if (isAbortError(repairError)) conversationStore.removeMessage(page.id, pendingMessage.id)
          throw repairError
        }

        await waitForCloseDecision()
        if (signal.aborted) {
          conversationStore.removeMessage(page.id, pendingMessage.id)
          throwIfAborted(signal)
        }
        if (editorStore.pageRevision !== baseRevision) {
          throw new Error('AI 处理期间页面已发生修改。为避免覆盖手工操作，请重新发送这条要求。')
        }
        if (repairResponse.result.type === 'need_clarification') {
          conversationStore.appendMessage(page.id, baseRevision, 'assistant', repairResponse.result.question)
          conversationStore.rememberUserIntent(page.id, baseRevision, message)
          conversationStore.rememberOpenQuestion(page.id, baseRevision, repairResponse.result.question)
          return
        }
        if (repairResponse.result.type === 'page_edit_plan') {
          throw new Error('AI 修正请求返回了新的大改计划，已取消本次修改。')
        }
        patch = repairResponse.result
      }
    }
  }

  if (editorStore.pageRevision !== baseRevision) {
    throw new Error('AI 处理期间页面已发生修改。为避免覆盖手工操作，请重新发送这条要求。')
  }
  progressText.value = stepCount > 1 ? '所有步骤已通过校验，正在一次性提交页面…' : '正在提交修改…'
  editorStore.applyAIPagePatchTransaction(nextPage, summary, baseRevision)
  editorStore.persistPage()
  const nextRevision = editorStore.pageRevision
  conversationStore.appendMessage(
    page.id,
    nextRevision,
    'assistant',
    `已完成：${summary}`,
    allWarnings.length
      ? `分 ${stepCount} 步执行 ${operationCount} 个操作，并安全修复 ${allWarnings.length} 项数据；已作为一条命令提交。`
      : `分 ${stepCount} 步执行 ${operationCount} 个增量操作，已作为一条命令提交，可通过顶部撤销恢复。`
  )
  conversationStore.rememberUserIntent(page.id, nextRevision, message)
  conversationStore.rememberCompletedChange(page.id, nextRevision, summary)
  ElMessage.success(`AI 增量修改完成：${summary}`)
}

const submit = async () => {
  const message = prompt.value.trim()
  if (!message) {
    errorMessage.value = mode.value === 'generate'
      ? '请先输入页面需求，例如页面结构、核心组件和视觉风格。'
      : '请先描述需要修改的内容。'
    return
  }
  loading.value = true
  errorMessage.value = ''
  const controller = new AbortController()
  activeRequest.value = controller
  try {
    if (mode.value === 'generate') await generate(message, controller.signal)
    else await edit(message, controller.signal)
    throwIfAborted(controller.signal)
    prompt.value = ''
  } catch (error) {
    if (isAbortError(error)) {
      errorMessage.value = ''
      ElMessage.info('已取消本次 AI 请求')
    } else {
      errorMessage.value = error instanceof Error ? error.message : 'AI 页面处理失败，请稍后重试。'
    }
  } finally {
    if (activeRequest.value === controller) activeRequest.value = null
    loading.value = false
    progressText.value = ''
    scrollToLatest()
  }
}

const confirmClose = async () => {
  if (!loading.value) return true
  if (closeConfirming.value) return false
  closeConfirming.value = true
  let resolveDecision: ((confirmed: boolean) => void) | undefined
  const decision = new Promise<boolean>((resolve) => { resolveDecision = resolve })
  pendingCloseDecision = decision
  let shouldClose = false
  try {
    await ElMessageBox.confirm(
      '关闭将取消本次 AI 请求，是否继续？',
      '取消 AI 请求',
      {
        type: 'warning',
        confirmButtonText: '取消生成并关闭',
        cancelButtonText: '继续等待',
        closeOnClickModal: false,
        closeOnPressEscape: false
      }
    )
    activeRequest.value?.abort()
    shouldClose = true
    return true
  } catch {
    return false
  } finally {
    resolveDecision?.(shouldClose)
    if (pendingCloseDecision === decision) pendingCloseDecision = null
    closeConfirming.value = false
  }
}

const handleBeforeClose = async (done: () => void) => {
  if (await confirmClose()) done()
}

const requestClose = async () => {
  if (await confirmClose()) visible.value = false
}

const clearConversation = () => {
  const page = currentPage.value
  if (!page) return
  conversationStore.clearSession(page.id, editorStore.pageRevision)
  ElMessage.success('当前页面的 AI 对话已清空')
}

const undoLastAIChange = () => {
  if (!canUndoAI.value) return
  historyStore.undo()
  const page = currentPage.value
  if (page) {
    conversationStore.forgetLastCompletedChange(page.id, editorStore.pageRevision)
    conversationStore.appendMessage(page.id, editorStore.pageRevision, 'assistant', '已撤销上一轮 AI 修改，后续修改将以当前页面为准。')
    conversationStore.syncRevision(page.id, editorStore.pageRevision)
    editorStore.persistPage()
  }
  ElMessage.success('已撤销上一轮 AI 修改')
}
</script>

<style scoped>
.mode-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.revision { color: #94a3b8; font-size: 12px; }
.hint { margin: 12px 0; color: #64748b; font-size: 13px; line-height: 1.6; }
.messages { height: 280px; margin-bottom: 14px; padding: 16px; overflow-y: auto; border: 1px solid #e5e7eb; border-radius: 12px; background: #f8fafc; }
.messages.empty { display: flex; align-items: center; justify-content: center; }
.empty-state { display: flex; flex-direction: column; align-items: center; gap: 8px; color: #64748b; text-align: center; }
.empty-state strong { color: #334155; font-size: 15px; }
.empty-state span { max-width: 480px; font-size: 13px; line-height: 1.6; }
.message { display: flex; align-items: flex-start; gap: 8px; margin-bottom: 14px; }
.message.user { flex-direction: row-reverse; }
.message-role { flex: 0 0 28px; height: 28px; border-radius: 50%; background: #e2e8f0; color: #475569; font-size: 12px; line-height: 28px; text-align: center; }
.message.user .message-role { background: #2563eb; color: #fff; }
.message-bubble { max-width: 78%; padding: 9px 12px; border-radius: 12px; background: #fff; color: #334155; font-size: 13px; line-height: 1.65; white-space: pre-wrap; box-shadow: 0 1px 3px rgba(15,23,42,.08); }
.message.user .message-bubble { background: #2563eb; color: #fff; }
.message-bubble small { display: block; margin-top: 5px; color: #94a3b8; font-size: 11px; }
.message.user .message-bubble small { color: #dbeafe; }
.progress { display: flex; align-items: center; gap: 8px; margin-top: 12px; color: #2563eb; font-size: 13px; }
.dialog-footer { width: 100%; display: flex; align-items: center; justify-content: space-between; }
.footer-tools { display: flex; align-items: center; }
:deep(.ai-dialog .el-dialog__header) { cursor: move; user-select: none; }
</style>
