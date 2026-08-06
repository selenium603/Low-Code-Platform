import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { Command } from '@/types'

export const useHistoryStore = defineStore('history', () => {
  const undoStack = ref<Command[]>([])
  const redoStack = ref<Command[]>([])
  const maxHistorySize = ref(100)

  const canUndo = computed(() => undoStack.value.length > 0)
  const canRedo = computed(() => redoStack.value.length > 0)

  const executeCommand = (command: Command) => {
    command.execute()
    undoStack.value.push(command)

    if (undoStack.value.length > maxHistorySize.value) {
      undoStack.value.shift()
    }

    redoStack.value = []
  }

  const undo = () => {
    const command = undoStack.value.pop()
    if (!command) return

    command.undo()
    redoStack.value.push(command)
  }

  const redo = () => {
    const command = redoStack.value.pop()
    if (!command) return

    command.execute()
    undoStack.value.push(command)
    if (undoStack.value.length > maxHistorySize.value) {
      undoStack.value.shift()
    }
  }

  const clearHistory = () => {
    undoStack.value = []
    redoStack.value = []
  }

  return {
    undoStack,
    redoStack,
    maxHistorySize,
    canUndo,
    canRedo,
    executeCommand,
    undo,
    redo,
    clearHistory
  }
})
