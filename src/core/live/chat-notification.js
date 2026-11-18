/** Only new, live, other-user chat messages should generate desktop alerts. */
export function shouldNotifyChat({ raw, mapped, history, existing, currentName, identityKnown }) {
  if (history || existing || String(raw?.type || '').toUpperCase() !== 'CHAT' || mapped?.me) return false
  // Until /user/me arrives we cannot reliably distinguish our own messages.
  if (!identityKnown) return false
  if (!raw?.userId && currentName && raw?.userName === currentName) return false
  return true
}
