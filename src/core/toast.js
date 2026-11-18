import { reactive } from 'vue'

export const toasts = reactive([])
let seq = 0

export function pushToast(text, kind = 'info') {
  const id = ++seq
  toasts.push({ id, text, kind })
  setTimeout(() => {
    const index = toasts.findIndex((t) => t.id === id)
    if (index >= 0) toasts.splice(index, 1)
  }, 2400)
}
