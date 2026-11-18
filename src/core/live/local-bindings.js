/** Account identifiers belong to this device profile; never publish /app/user/bind. */
export const LOCAL_BINDINGS_KEY = 'mp.desktop.playlist-bindings.v1'
const sources = ['netease', 'bilibili', 'qqmusic']
let memoryBindings = {}

export function readLocalBindings(storage = globalThis.localStorage) {
  try {
    const parsed = JSON.parse(storage?.getItem(LOCAL_BINDINGS_KEY) || '{}')
    const result = {}
    for (const source of sources) {
      const item = parsed?.[source]
      if (item && typeof item.id === 'string' && item.id.trim()) {
        result[source] = { id: item.id.trim(), name: String(item.name || item.id).slice(0, 100) }
      }
    }
    memoryBindings = result
    return result
  } catch { return { ...memoryBindings } }
}

export function saveLocalBinding(source, user, storage = globalThis.localStorage) {
  if (!sources.includes(source)) throw new Error('不支持的平台')
  const bindings = readLocalBindings(storage)
  if (user == null) delete bindings[source]
  else {
    const id = String(user.id ?? '').trim()
    if (!id) throw new Error('用户 ID 不能为空')
    bindings[source] = { id, name: String(user.name || id).slice(0, 100) }
  }
  memoryBindings = bindings
  try { storage?.setItem(LOCAL_BINDINGS_KEY, JSON.stringify(bindings)) } catch { /* session-only fallback */ }
  return { ...bindings }
}
