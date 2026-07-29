import { createRouter, createWebHistory } from 'vue-router'
import { useAuthStore } from './stores/auth'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/login', name: 'login', component: () => import('./views/LoginPage.vue') },
    {
      path: '/pending',
      name: 'pending',
      component: () => import('./views/PendingPage.vue'),
      meta: { requiresAuth: true },
    },
    {
      path: '/join',
      name: 'join-team',
      component: () => import('./views/JoinTeamPage.vue'),
      meta: { requiresAuth: true },
    },
    {
      path: '/',
      component: () => import('./views/AppLayout.vue'),
      meta: { requiresAuth: true, requiresEnabled: true },
      children: [
        { path: '', redirect: '/tasks' },
        { path: 'tasks', name: 'tasks', component: () => import('./views/TasksPage.vue') },
        { path: 'pipeline', name: 'pipeline', component: () => import('./views/PipelinePage.vue') },
        { path: 'cases/:id', name: 'case', component: () => import('./views/CaseDetailPage.vue') },
        { path: 'operations', redirect: '/tasks' },
        { path: 'decisions/:pathMatch(.*)*', redirect: '/tasks' },
        { path: 'ask', name: 'ask', component: () => import('./views/AssistantPage.vue') },
        { path: 'workflows', name: 'workflows', component: () => import('./views/WorkflowsPage.vue') },
        { path: 'workflows/:id', name: 'workflow-editor', component: () => import('./views/WorkflowEditorPage.vue') },
        { path: 'contacts', name: 'contacts', component: () => import('./views/ContactsPage.vue') },
        { path: 'contacts/:id', name: 'contact', component: () => import('./views/ContactDetailPage.vue') },
        { path: 'sources', name: 'sources', component: () => import('./views/SourcesPage.vue') },
        { path: 'team', name: 'team', component: () => import('./views/TeamPage.vue') },
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

export default router
