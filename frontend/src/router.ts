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
        { path: '', name: 'assistant', component: () => import('./views/AssistantPage.vue') },
        { path: 'intake', name: 'inbox', component: () => import('./views/InboxPage.vue') },
        { path: 'intake/:id', name: 'intake-review', component: () => import('./views/RequestReviewPage.vue') },
        { path: 'requests', name: 'requests', component: () => import('./views/RequestsPage.vue') },
        { path: 'requests/:id', name: 'request', component: () => import('./views/ServiceRequestPage.vue') },
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
    return authStore.isEnabled ? { name: 'assistant' } : { name: 'pending' }
  }
  if (
    to.name === 'pending'
    && authStore.isAuthenticated
    && sessionStorage.getItem('pendingInvitationToken')
  ) return { name: 'join-team' }
})

export default router
