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
      path: '/',
      component: () => import('./views/AppLayout.vue'),
      meta: { requiresAuth: true, requiresEnabled: true },
      children: [
        { path: '', name: 'inbox', component: () => import('./views/InboxPage.vue') },
        { path: 'requests/:id', name: 'request', component: () => import('./views/RequestReviewPage.vue') },
      ],
    },
  ],
})

router.beforeEach(async (to) => {
  const authStore = useAuthStore()
  await authStore.initialize()
  const requiresAuth = to.matched.some((record) => record.meta.requiresAuth)
  const requiresEnabled = to.matched.some((record) => record.meta.requiresEnabled)

  if (requiresAuth && !authStore.isAuthenticated) return { name: 'login' }
  if (requiresEnabled && !authStore.isEnabled) return { name: 'pending' }
  if (to.name === 'login' && authStore.isAuthenticated) {
    return authStore.isEnabled ? { name: 'inbox' } : { name: 'pending' }
  }
})

export default router
