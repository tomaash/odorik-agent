<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import Button from 'primevue/button'
import InputNumber from 'primevue/inputnumber'
import InputText from 'primevue/inputtext'
import Select from 'primevue/select'
import Textarea from 'primevue/textarea'
import type { CreateTaskBlock } from '@agent-erik/workflow'
import type { TeamMember } from '../api/client'

const props = defineProps<{
  block: CreateTaskBlock
  members: TeamMember[]
  canMoveUp: boolean
  canMoveDown: boolean
  compact?: boolean
}>()

const emit = defineEmits<{
  moveUp: []
  moveDown: []
  remove: []
}>()

const { t } = useI18n()

const title = computed({
  get: () => props.block.task.title,
  set: (value: string) => { props.block.task.title = value },
})

const instructions = computed({
  get: () => props.block.task.instructions || '',
  set: (value: string) => { props.block.task.instructions = value },
})

const dueAfterDays = computed({
  get: () => props.block.task.dueAfterDays ?? null,
  set: (value: number | null) => { props.block.task.dueAfterDays = value },
})

const assigneeUid = computed({
  get: () => props.block.task.assigneeUid,
  set: (uid: string) => {
    const member = props.members.find((candidate) => candidate.uid === uid)
    props.block.task.assigneeUid = uid
    props.block.task.assigneeName = member?.displayName || ''
  },
})

const approverUid = computed({
  get: () => props.block.approval.approverUid,
  set: (uid: string) => {
    const member = props.members.find((candidate) => candidate.uid === uid)
    props.block.approval.approverUid = uid
    props.block.approval.approverName = member?.displayName || ''
  },
})
</script>

<template>
  <section
    class="rounded-lg border border-emerald-300 bg-emerald-50/80 shadow-sm overflow-hidden"
    :class="compact ? 'border-emerald-200 bg-white' : ''"
  >
    <header class="px-3 py-2.5 flex items-center gap-2 border-b border-emerald-200/80">
      <span class="w-8 h-8 shrink-0 rounded-md bg-emerald-700 text-white flex items-center justify-center">
        <i class="pi pi-check-square" />
      </span>
      <div class="min-w-0 flex-1">
        <span class="eyebrow !text-emerald-800">{{ t('workflows.taskBlock') }}</span>
        <strong class="block text-sm truncate">{{ block.task.title || t('workflows.untitledTask') }}</strong>
      </div>
      <div class="flex items-center">
        <Button
          icon="pi pi-arrow-up"
          severity="secondary"
          text
          size="small"
          :disabled="!canMoveUp"
          :aria-label="t('workflows.moveUp')"
          @click="emit('moveUp')"
        />
        <Button
          icon="pi pi-arrow-down"
          severity="secondary"
          text
          size="small"
          :disabled="!canMoveDown"
          :aria-label="t('workflows.moveDown')"
          @click="emit('moveDown')"
        />
        <Button
          icon="pi pi-trash"
          severity="danger"
          text
          size="small"
          :aria-label="t('workflows.removeBlock')"
          @click="emit('remove')"
        />
      </div>
    </header>

    <div class="p-3 grid gap-3">
      <label class="grid gap-1.5 text-sm font-medium">
        {{ t('workflows.fields.taskTitle') }}
        <InputText v-model="title" />
        <small class="text-surface-500 font-normal">
          {{ t('workflows.titleTokenHint') }}
          <code class="ml-1">{caller.name}</code>
          <code class="ml-1">{caller.phone}</code>
        </small>
      </label>
      <label class="grid gap-1.5 text-sm font-medium">
        {{ t('workflows.fields.instructions') }}
        <Textarea v-model="instructions" rows="2" autoResize />
      </label>
      <div class="grid sm:grid-cols-2 gap-3">
        <label class="grid gap-1.5 text-sm font-medium">
          {{ t('workflows.fields.assignee') }}
          <Select
            v-model="assigneeUid"
            :options="members"
            optionLabel="displayName"
            optionValue="uid"
          />
        </label>
        <label class="grid gap-1.5 text-sm font-medium">
          {{ t('workflows.fields.dueAfter') }}
          <div class="flex items-center gap-2">
            <InputNumber v-model="dueAfterDays" :min="0" :max="365" class="w-24" />
            <span class="text-sm text-surface-500">{{ t('workflows.days') }}</span>
          </div>
        </label>
      </div>
    </div>

    <section class="border-t-2 border-violet-300 bg-violet-50/90 px-3 py-3 grid sm:grid-cols-[minmax(0,1fr)_14rem] gap-3 items-center">
      <div class="flex items-start gap-2.5">
        <span class="w-8 h-8 shrink-0 rounded-md bg-violet-700 text-white flex items-center justify-center">
          <i class="pi pi-shield" />
        </span>
        <div>
          <strong class="block text-sm text-violet-950">{{ t('workflows.approval.required') }}</strong>
          <span class="block text-xs leading-relaxed text-violet-800 mt-0.5">{{ t('workflows.approval.body') }}</span>
        </div>
      </div>
      <label class="grid gap-1.5 text-sm font-medium text-violet-950">
        {{ t('workflows.fields.approver') }}
        <Select
          v-model="approverUid"
          :options="members"
          optionLabel="displayName"
          optionValue="uid"
        />
      </label>
    </section>
  </section>
</template>
