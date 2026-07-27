<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'

const router = useRouter()
const ready = ref(false)

router.isReady().finally(() => {
  ready.value = true
})
</script>

<template>
  <main v-if="!ready" class="app-boot" role="status" aria-live="polite">
    <div class="app-boot__mark" aria-hidden="true">CA</div>
    <div class="app-boot__spinner" aria-hidden="true" />
    <p class="app-boot__label">Načítám Company Agent…</p>
  </main>
  <router-view v-else />
</template>
