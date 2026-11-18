<script setup>
defineProps({ kind: { type: String, default: 'orbit' } })
</script>
<template>
  <svg viewBox="0 0 32 32" aria-hidden="true" class="geometric-avatar">
    <template v-if="kind === 'orbit'"><circle cx="16" cy="16" r="9" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="24" cy="9" r="3" fill="currentColor"/></template>
    <path v-else-if="kind === 'diamond'" d="M16 3 29 16 16 29 3 16Zm0 7-6 6 6 6 6-6Z" fill="currentColor" fill-rule="evenodd"/>
    <template v-else-if="kind === 'sun'"><circle cx="16" cy="16" r="6" fill="currentColor"/><path d="M16 2v5m0 18v5M2 16h5m18 0h5M6 6l4 4m12 12 4 4M26 6l-4 4M10 22l-4 4" fill="none" stroke="currentColor" stroke-width="2"/></template>
    <path v-else-if="kind === 'wave'" d="M3 12q6-8 13 0t13 0M3 21q6-8 13 0t13 0" fill="none" stroke="currentColor" stroke-width="3"/>
    <path v-else d="M4 4h10v10H4zm14 0h10v10H18zM4 18h10v10H4zm14 0h10v10H18z" fill="currentColor"/>
  </svg>
</template>
