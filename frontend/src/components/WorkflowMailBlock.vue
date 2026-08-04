<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import Button from 'primevue/button'
import InputText from 'primevue/inputtext'
import Message from 'primevue/message'
import Select from 'primevue/select'
import Textarea from 'primevue/textarea'
import type { MailDraftCreateBlock } from '@agent-erik/workflow'
import type { TeamMember } from '../api/client'

const props = defineProps<{
  block: MailDraftCreateBlock
  members: TeamMember[]
  mailboxes: Array<{ label: string; value: string }>
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

const approverUid = computed({
  get: () => props.block.approval.approverUid,
  set: (uid: string) => {
    const member = props.members.find((candidate) => candidate.uid === uid)
    props.block.approval.approverUid = uid
    props.block.approval.approverName = member?.displayName || ''
  },
})

const recipientKind = computed({
  get: () => props.block.mail.recipient.kind,
  set: (kind: 'contact' | 'literal') => {
    props.block.mail.recipient = kind === 'contact'
      ? { kind: 'contact' }
      : { kind: 'literal', email: '' }
  },
})

const recipientEmail = computed({
  get: () => (
    props.block.mail.recipient.kind === 'literal' ? props.block.mail.recipient.email : ''
  ),
  set: (email: string) => {
    if (props.block.mail.recipient.kind === 'literal') props.block.mail.recipient.email = email
  },
})

const recipientOptions = computed(() => [
  { label: t('workflows.mailRecipient.contact'), value: 'contact' },
  { label: t('workflows.mailRecipient.literal'), value: 'literal' },
])
</script>

<template>
  <section
    class="rounded-lg border border-sky-300 bg-sky-50/80 shadow-sm overflow-hidden"
    :class="compact ? 'bg-white' : ''"
  >
    <header class="px-3 py-2.5 flex items-center gap-2 border-b border-sky-200">
      <span class="w-8 h-8 shrink-0 rounded-md bg-sky-700 text-white flex items-center justify-center">
        <i class="pi pi-envelope" />
      </span>
      <div class="min-w-0 flex-1">
        <span class="eyebrow !text-sky-800">{{ t('workflows.mailDraftBlock') }}</span>
        <strong class="block text-sm truncate">
          {{ block.mail.subject || t('workflows.untitledDraft') }}
        </strong>
      </div>
      <div class="flex items-center">
        <Button icon="pi pi-arrow-up" severity="secondary" text size="small" :disabled="!canMoveUp" :aria-label="t('workflows.moveUp')" @click="emit('moveUp')" />
        <Button icon="pi pi-arrow-down" severity="secondary" text size="small" :disabled="!canMoveDown" :aria-label="t('workflows.moveDown')" @click="emit('moveDown')" />
        <Button icon="pi pi-trash" severity="danger" text size="small" :aria-label="t('workflows.removeBlock')" @click="emit('remove')" />
      </div>
    </header>

    <div class="p-3 grid gap-3">
      <div class="grid sm:grid-cols-2 gap-3">
        <label class="grid gap-1.5 text-sm font-medium">
          {{ t('workflows.fields.mailbox') }}
          <Select
            v-model="block.mail.connectionId"
            :options="mailboxes"
            optionLabel="label"
            optionValue="value"
            :placeholder="t('workflows.fields.mailboxPlaceholder')"
          />
        </label>
        <label class="grid gap-1.5 text-sm font-medium">
          {{ t('workflows.fields.recipient') }}
          <Select v-model="recipientKind" :options="recipientOptions" optionLabel="label" optionValue="value" />
        </label>
      </div>

      <label v-if="recipientKind === 'literal'" class="grid gap-1.5 text-sm font-medium">
        {{ t('workflows.fields.recipientEmail') }}
        <InputText v-model="recipientEmail" type="email" placeholder="name@company.com" />
      </label>

      <label class="grid gap-1.5 text-sm font-medium">
        {{ t('workflows.fields.mailSubject') }}
        <InputText v-model="block.mail.subject" />
        <small class="text-surface-500 font-normal">
          {{ t('workflows.titleTokenHint') }} <code>{caller.name}</code>
        </small>
      </label>

      <label class="grid gap-1.5 text-sm font-medium">
        {{ t('workflows.fields.mailBody') }}
        <Textarea v-model="block.mail.body" rows="6" autoResize />
        <small class="text-surface-500 font-normal">
          {{ t('workflows.titleTokenHint') }}
          <code>{caller.name}</code>, <code>{call.summary}</code>
        </small>
      </label>

      <Message severity="info" :closable="false">{{ t('workflows.mailDraftOnly') }}</Message>
      <Message v-if="recipientKind === 'contact'" severity="warn" :closable="false">
        {{ t('workflows.mailNeedsContactEmail') }}
      </Message>
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
