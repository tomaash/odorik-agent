/**
 * Shared open/close state for the contact modal.
 *
 * The form lives in one place and every CTA on the site opens it, so the state
 * has to outlive any single component — useState keeps it app-wide.
 */
export function useContactModal() {
  const isOpen = useState('contactModal', () => false)

  return {
    isOpen,
    open: () => {
      isOpen.value = true
    },
    close: () => {
      isOpen.value = false
    },
  }
}
