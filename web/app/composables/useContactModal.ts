/**
 * Shared open/close state for the contact modal.
 *
 * The form lives in one place and every CTA on the site opens it, so the state
 * has to outlive any single component — useState keeps it app-wide.
 */
export function useContactModal() {
  const isOpen = useState('contactModal', () => false)
  const sent = useState('contactModalSent', () => false)

  return {
    isOpen,
    /** True once a submission landed, so the modal shows the confirmation. */
    sent,
    open: () => {
      // Reset here rather than in a watcher on isOpen: closing and reopening
      // quickly nets no observed change, so a watcher would leave the stale
      // confirmation in place.
      sent.value = false
      isOpen.value = true
    },
    close: () => {
      isOpen.value = false
    },
    markSent: () => {
      sent.value = true
    },
  }
}
