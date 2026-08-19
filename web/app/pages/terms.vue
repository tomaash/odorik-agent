<script setup lang="ts">
const { t } = useI18n()

useHead({
  title: t('meta.termsTitle'),
})
</script>

<template>
  <TermsContent />
</template>
