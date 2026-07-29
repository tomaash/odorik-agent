<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import Button from 'primevue/button'
import InputText from 'primevue/inputtext'
import Message from 'primevue/message'
import Select from 'primevue/select'
import type { CreateCaseBlock, MoveCaseBlock } from '@agent-erik/workflow'
import type { Pipeline, TeamMember } from '../api/client'

const props = defineProps<{
  block: CreateCaseBlock | MoveCaseBlock
  members: TeamMember[]
  pipeline: Pipeline
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
const activeStages = computed(() => props.pipeline.stages.filter((stage) => !stage.archived))
const approverUid = computed({
  get: () => props.block.approval.approverUid,
  set: (uid: string) => {
    const member = props.members.find((candidate) => candidate.uid === uid)
    props.block.approval.approverUid = uid
    props.block.approval.approverName = member?.displayName || ''
  },
})

function setOwner(uid: string) {
  if (props.block.kind !== 'action.case.create') return
  const member = props.members.find((candidate) => candidate.uid === uid)
  props.block.case.ownerUid = uid
  props.block.case.ownerName = member?.displayName || ''
}

function setCreateStage(stageId: string) {
  if (props.block.kind !== 'action.case.create') return
  const stage = activeStages.value.find((candidate) => candidate.id === stageId)
  props.block.case.stageId = stageId
  props.block.case.stageName = stage?.name || ''
}

function setMoveStage(side: 'from' | 'to', stageId: string) {
  if (props.block.kind !== 'action.case.move') return
  const stage = activeStages.value.find((candidate) => candidate.id === stageId)
  if (side === 'from') {
    props.block.case.fromStageId = stageId
    props.block.case.fromStageName = stage?.name || ''
  } else {
    props.block.case.toStageId = stageId
    props.block.case.toStageName = stage?.name || ''
  }
}
</script>

<template>
  <section class="rounded-lg border border-teal-300 bg-teal-50/80 shadow-sm overflow-hidden" :class="compact ? 'bg-white' : ''">
    <header class="px-3 py-2.5 flex items-center gap-2 border-b border-teal-200">
      <span class="w-8 h-8 shrink-0 rounded-md bg-teal-700 text-white flex items-center justify-center">
        <i :class="block.kind === 'action.case.create' ? 'pi pi-folder-plus' : 'pi pi-arrow-right-arrow-left'" />
      </span>
      <div class="min-w-0 flex-1">
        <span class="eyebrow !text-teal-800">
          {{ block.kind === 'action.case.create' ? t('workflows.createCaseBlock') : t('workflows.moveCaseBlock') }}
        </span>
        <strong class="block text-sm truncate">
          {{ block.kind === 'action.case.create' ? (block.case.title || t('workflows.untitledCase')) : `${block.case.fromStageName} → ${block.case.toStageName}` }}
        </strong>
      </div>
      <div class="flex items-center">
        <Button icon="pi pi-arrow-up" severity="secondary" text size="small" :disabled="!canMoveUp" :aria-label="t('workflows.moveUp')" @click="emit('moveUp')" />
        <Button icon="pi pi-arrow-down" severity="secondary" text size="small" :disabled="!canMoveDown" :aria-label="t('workflows.moveDown')" @click="emit('moveDown')" />
        <Button icon="pi pi-trash" severity="danger" text size="small" :aria-label="t('workflows.removeBlock')" @click="emit('remove')" />
      </div>
    </header>

    <div v-if="block.kind === 'action.case.create'" class="p-3 grid gap-3">
      <label class="grid gap-1.5 text-sm font-medium">
        {{ t('workflows.fields.caseTitle') }}
        <InputText v-model="block.case.title" />
        <small class="text-surface-500 font-normal">{{ t('workflows.titleTokenHint') }} <code>{caller.name}</code></small>
      </label>
      <div class="grid sm:grid-cols-2 gap-3">
        <label class="grid gap-1.5 text-sm font-medium">
          {{ t('workflows.fields.owner') }}
          <Select :modelValue="block.case.ownerUid" :options="members" optionLabel="displayName" optionValue="uid" @update:modelValue="setOwner" />
        </label>
        <label class="grid gap-1.5 text-sm font-medium">
          {{ t('workflows.fields.initialStage') }}
          <Select :modelValue="block.case.stageId" :options="activeStages" optionLabel="name" optionValue="id" @update:modelValue="setCreateStage" />
        </label>
      </div>
      <Message severity="info" :closable="false">{{ t('workflows.caseNeedsContact') }}</Message>
    </div>

    <div v-else class="p-3 grid gap-3">
      <div class="grid sm:grid-cols-2 gap-3">
        <label class="grid gap-1.5 text-sm font-medium">
          {{ t('workflows.fields.fromStage') }}
          <Select :modelValue="block.case.fromStageId" :options="activeStages" optionLabel="name" optionValue="id" @update:modelValue="(value) => setMoveStage('from', value)" />
        </label>
        <label class="grid gap-1.5 text-sm font-medium">
          {{ t('workflows.fields.toStage') }}
          <Select :modelValue="block.case.toStageId" :options="activeStages" optionLabel="name" optionValue="id" @update:modelValue="(value) => setMoveStage('to', value)" />
        </label>
      </div>
      <Message severity="info" :closable="false">{{ t('workflows.moveCaseExact') }}</Message>
    </div>

    <section class="border-t-2 border-violet-300 bg-violet-50/90 px-3 py-3 grid sm:grid-cols-[minmax(0,1fr)_14rem] gap-3 items-center">
      <div class="flex items-start gap-2.5">
        <span class="w-8 h-8 shrink-0 rounded-md bg-violet-700 text-white flex items-center justify-center"><i class="pi pi-shield" /></span>
        <div>
          <strong class="block text-sm text-violet-950">{{ t('workflows.approval.required') }}</strong>
          <span class="block text-xs leading-relaxed text-violet-800 mt-0.5">{{ t('workflows.approval.body') }}</span>
        </div>
      </div>
      <label class="grid gap-1.5 text-sm font-medium text-violet-950">
        {{ t('workflows.fields.approver') }}
        <Select v-model="approverUid" :options="members" optionLabel="displayName" optionValue="uid" />
      </label>
    </section>
  </section>
</template>
