<script setup>
import { toasts } from '../core/toast'
</script>

<template>
  <Teleport to="body">
    <div class="toast-stack" aria-live="polite">
      <TransitionGroup name="toast">
        <div v-for="toast in toasts" :key="toast.id" class="toast" :class="toast.kind">
          <span class="toast-dot"></span>
          {{ toast.text }}
        </div>
      </TransitionGroup>
    </div>
  </Teleport>
</template>
