import { reactive } from 'vue'
import { pushToast } from './toast'

export const connection = reactive({
  online: true,
  reconnecting: false,
  latency: 12,
  server: '127.0.0.1:8080',
  mode: '本地服务'
})

let recoverTimer = 0

export function goOffline({ autoRecover = true, delay = 2800 } = {}) {
  if (!connection.online) return
  connection.online = false
  connection.reconnecting = true
  pushToast('连接断开，正在重连…', 'warn')
  clearTimeout(recoverTimer)
  if (autoRecover) {
    recoverTimer = setTimeout(() => {
      connection.online = true
      connection.reconnecting = false
      connection.latency = 8 + Math.floor(Math.random() * 18)
      pushToast('已重新连接')
    }, delay)
  }
}

export function goOnline() {
  clearTimeout(recoverTimer)
  connection.online = true
  connection.reconnecting = false
  connection.latency = 8 + Math.floor(Math.random() * 18)
}
