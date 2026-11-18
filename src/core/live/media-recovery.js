/** Limit retries and discard results belonging to a changed room or playback. */
export function createMediaRecovery({ current, refresh, apply, schedule = setTimeout, cancel = clearTimeout }) {
  let generation = 0, attempts = 0, timer = null, inFlight = false
  function reset() {
    generation++
    attempts = 0
    if (timer) cancel(timer)
    timer = null
    inFlight = false
  }
  function request() {
    const snapshot = current()
    if (!snapshot?.playbackId || snapshot.kind !== 'SONG' || !snapshot.url || attempts >= 2 || timer || inFlight) return false
    const version = generation
    const delay = attempts ? 5500 : 1000
    timer = schedule(async () => {
      timer = null
      if (version !== generation) return
      attempts++
      inFlight = true
      try {
        const fresh = await refresh(snapshot.playbackId)
        const now = current()
        if (version !== generation || !now || now.session !== snapshot.session || now.playbackId !== snapshot.playbackId ||
            now.id !== snapshot.id || now.source !== snapshot.source || now.url !== snapshot.url) return
        if (String(fresh?.id) !== snapshot.id || fresh?.platform !== snapshot.source || typeof fresh?.url !== 'string' ||
            !/^(?:https?:\/\/|\/media\/)/i.test(fresh.url)) throw new Error('媒体地址无效或曲目已切换')
        apply(fresh.url, now)
      } catch {
        if (version === generation && attempts < 2) {
          inFlight = false
          request()
        }
      } finally {
        if (version === generation) inFlight = false
      }
    }, delay)
    return true
  }
  return { request, reset }
}
