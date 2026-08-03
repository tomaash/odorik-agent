import { createRouter, createWebHistory } from 'vue-router'
import { useAuthStore } from './stores/auth'
import { lazyRoute, recoverFromStaleChunkError } from './chunk-load-recovery'

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
      path: '/',
      component: lazyRoute(() => import('./views/AppLayout.vue')),
      meta: { requiresAuth: true, requiresEnabled: true },
      children: [
        { path: '', redirect: '/tasks' },
        { path: 'tasks', name: 'tasks', component: lazyRoute(() => import('./views/TasksPage.vue')) },
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
  if (to.name === 'join-team' && invitationToken) {
    sessionStorage.setItem('pendingInvitationToken', invitationToken)
    return { name: 'join-team', replace: true }
  }
  await authStore.initialize()
  const requiresAuth = to.matched.some((record) => record.meta.requiresAuth)
  const requiresEnabled = to.matched.some((record) => record.meta.requiresEnabled)

  if (requiresAuth && !authStore.isAuthenticated) return { name: 'login' }
  if (requiresEnabled && !authStore.isEnabled) return { name: 'pending' }
  if (to.name === 'login' && authStore.isAuthenticated) {
    if (sessionStorage.getItem('pendingInvitationToken')) return { name: 'join-team' }
    return authStore.isEnabled ? { name: 'tasks' } : { name: 'pending' }
  }
  if (
    to.name === 'pending'
    && authStore.isAuthenticated
    && sessionStorage.getItem('pendingInvitationToken')
  ) return { name: 'join-team' }
})

router.onError((error) => {
  recoverFromStaleChunkError(error)
})

export default router
