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
  <section>
    <Button label="Back to inbox" icon="pi pi-arrow-left" severity="secondary" text class="mb-5" @click="router.push('/')" />
    <Message v-if="store.error" severity="error" :closable="false">{{ store.error }}</Message>
    <div v-if="store.loading && !details" class="flex justify-center py-24"><ProgressSpinner /></div>

    <template v-else-if="details">
      <div class="flex items-start justify-between gap-4 flex-wrap mb-7">
        <div>
          <div class="flex items-center gap-2 mb-2">
            <Tag value="Human review required" severity="warn" rounded />
            <Tag :value="String(details.processingRun?.model || 'Gemini')" severity="secondary" rounded />
          </div>
          <h1 class="text-4xl font-bold tracking-tight">Review telephone intake</h1>
          <p class="text-surface-500 mt-2">Proposals are evidence, not company truth, until you approve this form.</p>
        </div>
        <Button label="Approve intake" icon="pi pi-check" size="large" :loading="saving" :disabled="!form.title.trim()" @click="saveReview" />
      </div>

      <div class="grid xl:grid-cols-[minmax(0,1.05fr)_minmax(380px,.95fr)] gap-6 items-start">
        <div class="grid gap-5">
          <Card class="rounded-2xl border border-surface-200 shadow-sm">
            <template #title><div class="flex items-center gap-2"><i class="pi pi-user text-emerald-700" /> Customer</div></template>
            <template #content>
              <div class="grid sm:grid-cols-2 gap-4">
                <label class="grid gap-2 text-sm font-medium">Name<InputText v-model="form.contactName" fluid /></label>
                <label class="grid gap-2 text-sm font-medium">Phone<InputText :modelValue="String(details.contact?.phoneE164 || details.contact?.phoneRaw || '')" disabled fluid /></label>
                <label class="grid gap-2 text-sm font-medium sm:col-span-2">Email<InputText v-model="form.email" type="email" fluid /></label>
              </div>
            </template>
          </Card>

          <Card class="rounded-2xl border border-surface-200 shadow-sm">
            <template #title><div class="flex items-center gap-2"><i class="pi pi-briefcase text-emerald-700" /> Service request</div></template>
            <template #content>
              <div class="grid gap-4">
                <label class="grid gap-2 text-sm font-medium">Request title<InputText v-model="form.title" fluid /></label>
                <div class="grid sm:grid-cols-2 gap-4">
                  <label class="grid gap-2 text-sm font-medium">Service type<InputText v-model="form.serviceType" fluid /></label>
                  <label class="grid gap-2 text-sm font-medium">Urgency
                    <Select v-model="form.urgency" :options="[{label:'Normal',value:'normal'},{label:'Urgent',value:'urgent'}]" optionLabel="label" optionValue="value" fluid />
                  </label>
                </div>
                <label class="grid gap-2 text-sm font-medium">Description<Textarea v-model="form.description" rows="5" autoResize fluid /></label>
                <label class="grid gap-2 text-sm font-medium">Address<InputText v-model="form.address" fluid /></label>
                <label class="grid gap-2 text-sm font-medium">Requested timing<InputText v-model="form.requestedTiming" fluid /><small class="font-normal text-surface-400">Customer preference, not a scheduled commitment.</small></label>
                <label class="grid gap-2 text-sm font-medium">Notes<Textarea v-model="form.notes" rows="3" autoResize fluid /></label>
                <label class="grid gap-2 text-sm font-medium">Missing information<Textarea v-model="form.missingInformationText" rows="4" autoResize fluid /><small class="font-normal text-surface-400">One item per line.</small></label>
              </div>
            </template>
          </Card>

          <Card class="rounded-2xl border border-surface-200 shadow-sm">
            <template #title>Model proposals and evidence</template>
            <template #content>
              <div v-if="proposals.length" class="grid gap-3">
                <div v-for="proposal in proposals" :key="proposal.field" class="border border-surface-200 rounded-xl p-4">
                  <div class="flex justify-between gap-3 items-center mb-2">
                    <strong>{{ proposal.field }}</strong>
                    <Tag :value="proposal.support" :severity="proposal.support === 'explicit' ? 'success' : 'warn'" rounded />
                  </div>
                  <p class="m-0 text-surface-700">{{ proposal.value }}</p>
                  <div v-if="proposal.evidence.length" class="flex gap-2 flex-wrap mt-3">
                    <button v-for="evidence in proposal.evidence" :key="`${proposal.field}-${evidence.segmentIndex}`" type="button" class="text-left text-xs bg-emerald-50 text-emerald-800 border border-emerald-200 rounded-lg px-3 py-2 cursor-pointer hover:bg-emerald-100" @click="focusEvidence(evidence.segmentIndex)">
                      “{{ evidence.quote }}”
                    </button>
                  </div>
                </div>
              </div>
              <p v-else class="text-surface-500">No model proposals were retained.</p>
            </template>
          </Card>
        </div>

        <Card class="rounded-2xl border border-surface-200 shadow-sm xl:sticky xl:top-24 max-h-[calc(100vh-8rem)] overflow-hidden">
          <template #title><div class="flex items-center gap-2"><i class="pi pi-align-left text-emerald-700" /> Transcript</div></template>
          <template #subtitle>{{ details.interaction?.summary }}</template>
          <template #content>
            <div class="overflow-y-auto max-h-[calc(100vh-16rem)] pr-2 grid gap-3">
              <div
                v-for="(segment, index) in segments"
                :key="index"
                :ref="(element) => setSegmentElement(element, index)"
                class="transcript-segment border border-surface-200 rounded-xl p-4 transition"
                :data-active="activeSegment === index"
              >
                <div class="text-xs uppercase tracking-wide text-surface-400 mb-1">{{ segment.speaker || `Speaker ${index + 1}` }}</div>
                <p class="m-0 leading-relaxed">{{ segment.text }}</p>
              </div>
              <p v-if="segments.length === 0" class="whitespace-pre-wrap leading-relaxed">{{ details.interaction?.transcript }}</p>
            </div>
          </template>
        </Card>
      </div>
    </template>
  </section>
</template>
