<script setup lang="ts">
import { computed, nextTick, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useToast } from 'primevue/usetoast'
import { trpc, type FieldProposal } from '../api/client'
import { useIntakeStore } from '../stores/intake'
import Button from 'primevue/button'
import Card from 'primevue/card'
import InputText from 'primevue/inputtext'
import Message from 'primevue/message'
import ProgressSpinner from 'primevue/progressspinner'
import Select from 'primevue/select'
import Tag from 'primevue/tag'
import Textarea from 'primevue/textarea'

const route = useRoute()
const router = useRouter()
const toast = useToast()
const store = useIntakeStore()
const saving = ref(false)
const activeSegment = ref<number | null>(null)
const segmentElements = ref<HTMLElement[]>([])

const form = reactive({
  contactName: '',
  email: '',
  title: '',
  serviceType: '',
  description: '',
  address: '',
  requestedTiming: '',
  urgency: 'normal' as 'normal' | 'urgent',
  notes: '',
  missingInformationText: '',
})

const details = computed(() => store.current)
const proposals = computed<FieldProposal[]>(() => details.value?.processingRun?.proposals || [])
const segments = computed(() => details.value?.interaction?.segments || [])
const proposalByField = computed(() => new Map(proposals.value.map((proposal) => [proposal.field, proposal])))

function proposalValue(field: FieldProposal['field']) {
  return proposalByField.value.get(field)?.value || ''
}

function hydrate() {
  const request = (details.value?.request || {}) as Record<string, unknown>
  const contact = (details.value?.contact || {}) as Record<string, unknown>
  form.contactName = String(contact.displayName || proposalValue('contactName'))
  form.email = String(contact.email || '')
  form.title = String(request.title || proposalValue('requestTitle') || details.value?.interaction?.summary || '')
  form.serviceType = String(request.serviceType || proposalValue('serviceType'))
  form.description = String(request.description || proposalValue('description'))
  form.address = String(request.address || proposalValue('address'))
  form.requestedTiming = String(request.requestedTiming || proposalValue('requestedTiming'))
  form.urgency = String(request.urgency || proposalValue('urgency')).toLowerCase() === 'urgent' ? 'urgent' : 'normal'
  form.notes = String(request.notes || proposalValue('notes'))
  form.missingInformationText = ((request.missingInformation as string[] | undefined) || []).join('\n')
}

watch(details, hydrate)

function currentValue(field: FieldProposal['field']) {
  const values: Record<FieldProposal['field'], string> = {
    contactName: form.contactName,
    requestTitle: form.title,
    serviceType: form.serviceType,
    description: form.description,
    address: form.address,
    requestedTiming: form.requestedTiming,
    urgency: form.urgency,
    notes: form.notes,
  }
  return values[field].trim()
}

function buildDecisions() {
  return proposals.value.map((proposal) => {
    const finalValue = currentValue(proposal.field)
    return {
      field: proposal.field,
      decision: (!finalValue ? 'rejected' : finalValue === proposal.value.trim() ? 'accepted' : 'corrected') as 'accepted' | 'corrected' | 'rejected',
      originalValue: proposal.value,
      finalValue: finalValue || undefined,
    }
  })
}

async function focusEvidence(segmentIndex: number) {
  activeSegment.value = segmentIndex
  await nextTick()
  segmentElements.value[segmentIndex]?.scrollIntoView({ behavior: 'smooth', block: 'center' })
}

function setSegmentElement(element: Element | { $el?: Element } | null, index: number) {
  const resolved = element instanceof Element ? element : element?.$el
  if (resolved instanceof HTMLElement) segmentElements.value[index] = resolved
}

async function saveReview() {
  if (!details.value || !form.title.trim()) return
  saving.value = true
  try {
    await trpc.intake.review.mutate({
      requestId: details.value.request.id,
      expectedRevision: Number(details.value.request.revision || 0),
      contact: {
        displayName: form.contactName.trim() || undefined,
        email: form.email.trim(),
      },
      request: {
        title: form.title.trim(),
        serviceType: form.serviceType.trim() || undefined,
        description: form.description.trim() || undefined,
        address: form.address.trim() || undefined,
        requestedTiming: form.requestedTiming.trim() || undefined,
        urgency: form.urgency,
        notes: form.notes.trim() || undefined,
        missingInformation: form.missingInformationText.split('\n').map((item) => item.trim()).filter(Boolean),
      },
      decisions: buildDecisions(),
    })
    toast.add({ severity: 'success', summary: 'Intake approved', detail: 'Canonical CRM data was saved.', life: 3500 })
    await router.push('/')
  } catch (cause) {
    toast.add({ severity: 'error', summary: 'Could not save', detail: cause instanceof Error ? cause.message : String(cause), life: 6000 })
  } finally {
    saving.value = false
  }
}

store.load(String(route.params.id))
</script>

<template>
  <section class="min-w-0">
    <Button label="Back to inbox" icon="pi pi-arrow-left" severity="secondary" text class="max-w-full mb-4 sm:mb-5" @click="router.push('/')" />
    <Message v-if="store.error" severity="error" :closable="false">{{ store.error }}</Message>
    <div v-if="store.loading && !details" class="flex justify-center py-24"><ProgressSpinner /></div>

    <template v-else-if="details">
      <div class="min-w-0 grid gap-4 sm:flex sm:items-start sm:justify-between mb-6 sm:mb-7">
        <div class="min-w-0">
          <div class="flex items-center gap-2 flex-wrap mb-2">
            <Tag value="Human review required" severity="warn" rounded />
            <Tag :value="String(details.processingRun?.model || 'Gemini')" severity="secondary" rounded />
          </div>
          <h1 class="text-3xl sm:text-4xl font-bold tracking-tight leading-tight break-words">Review telephone intake</h1>
          <p class="text-surface-500 leading-relaxed mt-2 max-w-3xl">Proposals are evidence, not company truth, until you approve this form.</p>
        </div>
        <Button label="Approve intake" icon="pi pi-check" size="large" class="w-full sm:w-auto shrink-0" :loading="saving" :disabled="!form.title.trim()" @click="saveReview" />
      </div>

      <div class="min-w-0 grid xl:grid-cols-[minmax(0,1.05fr)_minmax(380px,.95fr)] gap-5 sm:gap-6 items-start">
        <div class="min-w-0 grid gap-5">
          <Card class="min-w-0 overflow-hidden rounded-2xl border border-surface-200 shadow-sm [&_.p-card-body]:p-4 sm:[&_.p-card-body]:p-6">
            <template #title><div class="flex items-center gap-2 break-words"><i class="pi pi-user text-emerald-700 shrink-0" /> Customer</div></template>
            <template #content>
              <div class="min-w-0 grid sm:grid-cols-2 gap-4">
                <label class="min-w-0 grid gap-2 text-sm font-medium">Name<InputText v-model="form.contactName" class="min-w-0 max-w-full" fluid /></label>
                <label class="min-w-0 grid gap-2 text-sm font-medium">Phone<InputText :modelValue="String(details.contact?.phoneE164 || details.contact?.phoneRaw || '')" class="min-w-0 max-w-full" disabled fluid /></label>
                <label class="min-w-0 grid gap-2 text-sm font-medium sm:col-span-2">Email<InputText v-model="form.email" class="min-w-0 max-w-full" type="email" fluid /></label>
              </div>
            </template>
          </Card>

          <Card class="min-w-0 overflow-hidden rounded-2xl border border-surface-200 shadow-sm [&_.p-card-body]:p-4 sm:[&_.p-card-body]:p-6">
            <template #title><div class="flex items-center gap-2 break-words"><i class="pi pi-briefcase text-emerald-700 shrink-0" /> Service request</div></template>
            <template #content>
              <div class="min-w-0 grid gap-4">
                <label class="min-w-0 grid gap-2 text-sm font-medium">Request title<InputText v-model="form.title" class="min-w-0 max-w-full" fluid /></label>
                <div class="min-w-0 grid sm:grid-cols-2 gap-4">
                  <label class="min-w-0 grid gap-2 text-sm font-medium">Service type<InputText v-model="form.serviceType" class="min-w-0 max-w-full" fluid /></label>
                  <label class="min-w-0 grid gap-2 text-sm font-medium">Urgency
                    <Select v-model="form.urgency" class="min-w-0 max-w-full" :options="[{label:'Normal',value:'normal'},{label:'Urgent',value:'urgent'}]" optionLabel="label" optionValue="value" fluid />
                  </label>
                </div>
                <label class="min-w-0 grid gap-2 text-sm font-medium">Description<Textarea v-model="form.description" class="min-w-0 max-w-full" rows="5" autoResize fluid /></label>
                <label class="min-w-0 grid gap-2 text-sm font-medium">Address<InputText v-model="form.address" class="min-w-0 max-w-full" fluid /></label>
                <label class="min-w-0 grid gap-2 text-sm font-medium">Requested timing<InputText v-model="form.requestedTiming" class="min-w-0 max-w-full" fluid /><small class="font-normal text-surface-400 break-words">Customer preference, not a scheduled commitment.</small></label>
                <label class="min-w-0 grid gap-2 text-sm font-medium">Notes<Textarea v-model="form.notes" class="min-w-0 max-w-full" rows="3" autoResize fluid /></label>
                <label class="min-w-0 grid gap-2 text-sm font-medium">Missing information<Textarea v-model="form.missingInformationText" class="min-w-0 max-w-full" rows="4" autoResize fluid /><small class="font-normal text-surface-400">One item per line.</small></label>
              </div>
            </template>
          </Card>

          <Card class="min-w-0 overflow-hidden rounded-2xl border border-surface-200 shadow-sm [&_.p-card-body]:p-4 sm:[&_.p-card-body]:p-6">
            <template #title><span class="break-words">Model proposals and evidence</span></template>
            <template #content>
              <div v-if="proposals.length" class="min-w-0 grid gap-3">
                <div v-for="proposal in proposals" :key="proposal.field" class="min-w-0 border border-surface-200 rounded-xl p-3 sm:p-4 overflow-hidden">
                  <div class="min-w-0 flex justify-between gap-2 sm:gap-3 items-center flex-wrap mb-2">
                    <strong class="min-w-0 break-words">{{ proposal.field }}</strong>
                    <Tag :value="proposal.support" :severity="proposal.support === 'explicit' ? 'success' : 'warn'" rounded />
                  </div>
                  <p class="max-w-full m-0 text-surface-700 leading-relaxed break-words">{{ proposal.value }}</p>
                  <div v-if="proposal.evidence.length" class="min-w-0 flex gap-2 flex-wrap mt-3">
                    <button v-for="evidence in proposal.evidence" :key="`${proposal.field}-${evidence.segmentIndex}`" type="button" class="max-w-full whitespace-normal break-words text-left text-xs bg-emerald-50 text-emerald-800 border border-emerald-200 rounded-lg px-3 py-2 cursor-pointer hover:bg-emerald-100" @click="focusEvidence(evidence.segmentIndex)">
                      “{{ evidence.quote }}”
                    </button>
                  </div>
                </div>
              </div>
              <p v-else class="text-surface-500">No model proposals were retained.</p>
            </template>
          </Card>
        </div>

        <Card class="min-w-0 overflow-hidden rounded-2xl border border-surface-200 shadow-sm xl:sticky xl:top-24 xl:max-h-[calc(100vh-8rem)] [&_.p-card-body]:p-4 sm:[&_.p-card-body]:p-6">
          <template #title><div class="flex items-center gap-2 break-words"><i class="pi pi-align-left text-emerald-700 shrink-0" /> Transcript</div></template>
          <template #subtitle><span class="block max-w-full break-words leading-relaxed">{{ details.interaction?.summary }}</span></template>
          <template #content>
            <div class="min-w-0 grid gap-3 xl:overflow-y-auto xl:max-h-[calc(100vh-16rem)] xl:pr-2">
              <div
                v-for="(segment, index) in segments"
                :key="index"
                :ref="(element) => setSegmentElement(element, index)"
                class="transcript-segment min-w-0 border border-surface-200 rounded-xl p-3 sm:p-4 transition overflow-hidden"
                :data-active="activeSegment === index"
              >
                <div class="text-xs uppercase tracking-wide text-surface-400 mb-1">{{ segment.speaker || `Speaker ${index + 1}` }}</div>
                <p class="max-w-full m-0 leading-relaxed break-words">{{ segment.text }}</p>
              </div>
              <p v-if="segments.length === 0" class="max-w-full whitespace-pre-wrap leading-relaxed break-words">{{ details.interaction?.transcript }}</p>
            </div>
          </template>
        </Card>
      </div>
    </template>
  </section>
</template>
