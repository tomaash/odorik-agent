import { createRouter, createWebHistory } from 'vue-router'
import { useAuthStore } from './stores/auth'
import { lazyRoute, recoverFromStaleChunkError } from './chunk-load-recovery'
import { rememberAppReturnPath, takeAppReturnPath } from './pending-return'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/login', name: 'login', component: lazyRoute(() => import('./views/LoginPage.vue')) },
    {
      path: '/pending',
      name: 'pending',
      component: lazyRoute(() => import('./views/PendingPage.vue')),
      meta: { requiresAuth: true },
    },
    {
      path: '/join',
      name: 'join-team',
      component: lazyRoute(() => import('./views/JoinTeamPage.vue')),
      meta: { requiresAuth: true },
    },
    {
      path: '/slack/link',
      name: 'slack-link',
      component: lazyRoute(() => import('./views/SlackLinkPage.vue')),
      meta: { requiresAuth: true, requiresEnabled: true },
    },
    {
      path: '/teams/link',
      name: 'microsoft-teams-link',
      component: lazyRoute(() => import('./views/MicrosoftTeamsLinkPage.vue')),
      meta: { requiresAuth: true, requiresEnabled: true },
    },
    {
      path: '/',
      component: lazyRoute(() => import('./views/AppLayout.vue')),
      meta: { requiresAuth: true, requiresEnabled: true },
      children: [
        { path: '', redirect: '/tasks' },
        { path: 'tasks', name: 'tasks', component: lazyRoute(() => import('./views/TasksPage.vue')) },
        { path: 'approvals/:id', name: 'approval', component: lazyRoute(() => import('./views/ApprovalPage.vue')) },
        { path: 'pipeline', name: 'pipeline', component: lazyRoute(() => import('./views/PipelinePage.vue')) },
        { path: 'cases/:id', name: 'case', component: lazyRoute(() => import('./views/CaseDetailPage.vue')) },
        { path: 'operations', redirect: '/tasks' },
        { path: 'decisions/:pathMatch(.*)*', redirect: '/tasks' },
        { path: 'ask', name: 'ask', component: lazyRoute(() => import('./views/AssistantPage.vue')) },
        { path: 'workflows', name: 'workflows', component: lazyRoute(() => import('./views/WorkflowsPage.vue')) },
        { path: 'workflows/:id', name: 'workflow-editor', component: lazyRoute(() => import('./views/WorkflowEditorPage.vue')) },
        { path: 'contacts', name: 'contacts', component: lazyRoute(() => import('./views/ContactsPage.vue')) },
        { path: 'contacts/:id', name: 'contact', component: lazyRoute(() => import('./views/ContactDetailPage.vue')) },
        { path: 'sources', name: 'sources', component: lazyRoute(() => import('./views/SourcesPage.vue')) },
        { path: 'coding', name: 'coding', component: lazyRoute(() => import('./views/CodingPage.vue')) },
        { path: 'team', name: 'team', component: lazyRoute(() => import('./views/TeamPage.vue')) },
      ],
    },
  ],
})

router.beforeEach(async (to) => {
  const authStore = useAuthStore()
  const invitationToken = typeof to.query.token === 'string' ? to.query.token : ''
  const slackLinkToken = typeof to.query.token === 'string' && to.name === 'slack-link'
    ? to.query.token
    : ''
  if (slackLinkToken) {
    sessionStorage.setItem('pendingSlackLinkToken', slackLinkToken)
    return { name: 'slack-link', replace: true }
  }
  const teamsLinkToken = typeof to.query.token === 'string' && to.name === 'microsoft-teams-link'
    ? to.query.token
    : ''
  if (teamsLinkToken) {
    sessionStorage.setItem('pendingMicrosoftTeamsLinkToken', teamsLinkToken)
    return { name: 'microsoft-teams-link', replace: true }
  }
  if (to.name === 'join-team' && invitationToken) {
    sessionStorage.setItem('pendingInvitationToken', invitationToken)
    return { name: 'join-team', replace: true }
  }
  await authStore.initialize()
  const requiresAuth = to.matched.some((record) => record.meta.requiresAuth)
  const requiresEnabled = to.matched.some((record) => record.meta.requiresEnabled)

  if (requiresAuth && !authStore.isAuthenticated) {
    rememberAppReturnPath(to.fullPath)
    return { name: 'login' }
  }
  if (requiresEnabled && !authStore.isEnabled) return { name: 'pending' }
  if (to.name === 'login' && authStore.isAuthenticated) {
    if (sessionStorage.getItem('pendingInvitationToken')) return { name: 'join-team' }
    if (sessionStorage.getItem('pendingSlackLinkToken')) return { name: 'slack-link' }
    if (sessionStorage.getItem('pendingMicrosoftTeamsLinkToken')) return { name: 'microsoft-teams-link' }
    const pendingReturn = takeAppReturnPath()
    if (pendingReturn) return pendingReturn
    return authStore.isEnabled ? { name: 'tasks' } : { name: 'pending' }
  }
  if (
    to.name === 'pending'
    && authStore.isAuthenticated
    && sessionStorage.getItem('pendingInvitationToken')
  ) return { name: 'join-team' }
  if (
    to.name === 'pending'
    && authStore.isAuthenticated
    && sessionStorage.getItem('pendingSlackLinkToken')
    && authStore.isEnabled
  ) return { name: 'slack-link' }
  if (
    to.name === 'pending'
    && authStore.isAuthenticated
    && sessionStorage.getItem('pendingMicrosoftTeamsLinkToken')
    && authStore.isEnabled
  ) return { name: 'microsoft-teams-link' }
})

router.onError((error) => {
  recoverFromStaleChunkError(error)
})

export default router
