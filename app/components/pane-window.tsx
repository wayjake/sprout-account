import { useEffect, useId, useRef } from "react";

/**
 * A modal settings window, drawn as a 1999 dialog but built on native
 * `<dialog>` — which brings the focus trap, the inert background, the top
 * layer, and focus restoration on close for free.
 *
 * Kept mounted (and opened/closed imperatively) rather than mounted on demand,
 * so `dialog.close()` runs and hands focus back to whatever opened it.
 *
 * Escape and ✕ don't close the dialog directly: they call `onClose`, which
 * drops `?pane=` from the URL, and the route change closes the window. One
 * source of truth, and the browser Back button behaves.
 */
export function PaneWindow({
  open,
  title,
  onClose,
  children,
  width = "44rem",
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  width?: string;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      headingRef.current?.focus();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  return (
    <dialog
      ref={dialogRef}
      className="pane-dialog"
      aria-labelledby={titleId}
      // The width goes on the dialog, not the box inside it: a shrink-to-fit
      // dialog sizes to its text's max-content width and then a narrower child
      // sits left-aligned inside it, which reads as off-centre.
      style={{ width: `min(${width}, calc(100vw - 1.5rem))` }}
      onCancel={(event) => {
        event.preventDefault(); // Escape: let the URL close it
        onClose();
      }}
    >
      {open && (
        <div className="bevel-out flex max-h-[85vh] w-full flex-col p-[3px]">
          <div className="titlebar flex items-center justify-between px-2 py-1">
            <h2
              ref={headingRef}
              id={titleId}
              tabIndex={-1}
              className="text-[12px] font-bold"
            >
              {title}
            </h2>
            <button
              type="button"
              className="titlebar-btn"
              aria-label={`Close ${title}`}
              onClick={onClose}
            >
              <span aria-hidden>✕</span>
            </button>
          </div>
          <div className="bevel-in mt-[3px] min-h-0 flex-1 overflow-y-auto overscroll-contain bg-ledger">
            {children}
          </div>
        </div>
      )}
    </dialog>
  );
}
