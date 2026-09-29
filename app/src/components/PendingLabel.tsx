/**
 * A button label that swaps to its pending text without resizing the button:
 * both are laid out in one grid cell, so the button keeps the wider one's
 * width, and the one not showing is hidden from sight and the accessible name.
 */
export function PendingLabel({ label, pending, isPending }: { label: string; pending: string; isPending: boolean }) {
  return (
    <span className="label-swap">
      <span aria-hidden={isPending ? true : undefined}>{label}</span>
      <span aria-hidden={isPending ? undefined : true}>{pending}</span>
    </span>
  );
}
