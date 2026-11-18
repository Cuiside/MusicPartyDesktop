<script setup>
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { createBarsVisualizer } from '../core/audio/visualizer'
import { engine } from '../core/audio/engine'
import { appearance } from '../core/appearance'

const el = ref(null)
let viz = null

onMounted(() => {
  if (el.value) viz = createBarsVisualizer(el.value, { engine })
  updateColors()
})
const updateColors = () => { if (viz) { viz.style.color = appearance.dark ? 'rgba(232,227,237,0.82)' : 'rgba(20,19,20,0.82)'; viz.style.accentColor = appearance.dark ? 'rgba(232,227,237,0.5)' : 'rgba(20,19,20,0.45)'; if (viz.reducedMotion) viz.drawOnce() } }
watch(() => appearance.dark, updateColors)

onBeforeUnmount(() => {
  viz?.destroy?.()
  viz = null
})
</script>

<template>
  <canvas ref="el" class="viz-canvas" aria-hidden="true"></canvas>
</template>
