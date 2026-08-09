import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { Category, SpendingClass } from "~/db/schema";
import { CLASS_DOT_STYLES, CLASS_LABELS } from "~/components/ui";

const CLASS_ORDER: SpendingClass[] = [
  "base",
  "living",
  "luxury",
  "income",
  "transfer",
];

export function CategoryOptions({ categories }: { categories: Category[] }) {
  return (
    <>
      {CLASS_ORDER.map((cls) => {
        const group = categories.filter((c) => c.spendingClass === cls);
        if (group.length === 0) return null;
        return (
          <optgroup key={cls} label={CLASS_LABELS[cls]}>
            {group.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </optgroup>
        );
      })}
    </>
  );
}

interface ComboOption {
  id: number | null;
  name: string;
  spendingClass: SpendingClass | null;
}

/**
 * A type-to-search category picker: a text box that filters the list as you
 * type, over a hidden input carrying the id so it posts exactly like the
 * `<select>` it replaces.
 *
 * `value` seeds the selection — it is not tracked after mount, so a caller
 * whose server value can change under it (the AI button filing a category,
 * say) remounts with `key`.
 *
 * The list is `position: fixed` rather than absolute because it lives inside
 * the transaction window's scrolling body, which would otherwise clip it. It
 * stays a DOM child of this component: a portal to `document.body` would land
 * outside the modal `<dialog>`, where the platform makes everything inert.
 */
export function CategoryCombobox({
  name,
  categories,
  value = null,
  label,
  ariaLabel,
  placeholder = "Type to search…",
  clearLabel = "Uncategorized",
  allowClear = true,
  emphasizeEmpty = false,
  className = "",
  onSelect,
}: {
  name: string;
  categories: Category[];
  value?: number | null;
  /** Rendered as this field's own `<label>`; omit and pass `ariaLabel`. */
  label?: string;
  ariaLabel?: string;
  placeholder?: string;
  /** Wording for the "no category" row; omitted entirely when `allowClear` is false. */
  clearLabel?: string;
  allowClear?: boolean;
  /** Paint the box yellow while nothing is picked, like the register does. */
  emphasizeEmpty?: boolean;
  className?: string;
  onSelect?: (categoryId: number | null) => void;
}) {
  const inputId = useId();
  const listId = useId();
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [selectedId, setSelectedId] = useState<number | null>(value);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState<{
    left: number;
    width: number;
    top?: number;
    bottom?: number;
    maxHeight: number;
  } | null>(null);

  const selected = categories.find((c) => c.id === selectedId) ?? null;
  const display = selected?.name ?? (allowClear ? clearLabel : "");

  const matches = useMemo<ComboOption[]>(() => {
    const q = query.trim().toLowerCase();
    // Same grouping order the `<select>` uses, flattened for arrow keys.
    const inOrder = CLASS_ORDER.flatMap((cls) =>
      categories.filter((c) => c.spendingClass === cls),
    );
    const hits = inOrder
      .filter(
        (c) =>
          !q ||
          c.name.toLowerCase().includes(q) ||
          CLASS_LABELS[c.spendingClass].toLowerCase().includes(q),
      )
      .map<ComboOption>((c) => ({
        id: c.id,
        name: c.name,
        spendingClass: c.spendingClass,
      }));
    if (allowClear && (!q || clearLabel.toLowerCase().includes(q))) {
      hits.unshift({ id: null, name: clearLabel, spendingClass: null });
    }
    return hits;
  }, [categories, query, allowClear, clearLabel]);

  // Fixed positioning has to be recomputed against the live rect, so the list
  // follows the box when the window behind it scrolls or resizes.
  useEffect(() => {
    if (!open) return;
    const place = () => {
      const el = inputRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const below = window.innerHeight - r.bottom - 8;
      const above = r.top - 8;
      const flip = below < 160 && above > below;
      setPos({
        left: r.left,
        width: r.width,
        ...(flip
          ? { bottom: window.innerHeight - r.top + 2 }
          : { top: r.bottom + 2 }),
        maxHeight: Math.min(288, Math.max(120, flip ? above : below)),
      });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);

  // Arrow keys walk past the visible slice of a long list.
  useEffect(() => {
    if (!open) return;
    document
      .getElementById(`${listId}-${active}`)
      ?.scrollIntoView({ block: "nearest" });
  }, [open, active, listId]);

  const openList = () => {
    setActive(0);
    setOpen(true);
  };
  /** Leave the list without changing anything, and put the box back. */
  const revert = () => {
    setQuery("");
    setOpen(false);
  };
  const commit = (option: ComboOption) => {
    setSelectedId(option.id);
    setQuery("");
    setOpen(false);
    onSelect?.(option.id);
  };

  return (
    <div ref={wrapRef} className={`relative ${className}`}>
      {label && (
        <label
          htmlFor={inputId}
          className="mb-1 block text-[11px] font-bold text-gray-800"
        >
          {label}:
        </label>
      )}
      {/* The value the form posts. Always rendered, even while empty: callers
          that repeat this field read the values back positionally. */}
      <input type="hidden" name={name} value={selectedId ?? ""} />
      <input
        ref={inputRef}
        id={inputId}
        type="text"
        role="combobox"
        aria-label={label ? undefined : ariaLabel}
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={
          open && matches[active] ? `${listId}-${active}` : undefined
        }
        autoComplete="off"
        value={open ? query : display}
        // While the list is open the box holds the search text, so the current
        // pick shows through as the placeholder rather than disappearing.
        placeholder={open && display ? display : placeholder}
        onChange={(e) => {
          setQuery(e.currentTarget.value);
          setActive(0);
          setOpen(true);
        }}
        onClick={() => {
          if (!open) openList();
        }}
        onBlur={(e) => {
          if (wrapRef.current?.contains(e.relatedTarget as Node | null)) return;
          // Typing a name and then clicking Save shouldn't quietly throw the
          // typing away — once the search has narrowed to a single category,
          // leaving the box takes it. Anything vaguer reverts.
          if (query.trim() && matches.length === 1) commit(matches[0]);
          else revert();
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            if (!open) openList();
            else setActive((i) => Math.min(i + 1, matches.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            if (!open) openList();
            else setActive((i) => Math.max(i - 1, 0));
          } else if (e.key === "Enter") {
            // An open list swallows Enter unconditionally — otherwise it would
            // submit the surrounding form with the *old* id and the typed
            // search would vanish without a word.
            if (!open) return;
            e.preventDefault();
            const pick = matches[active] ?? matches[0];
            if (pick) commit(pick);
            else revert();
          } else if (e.key === "Escape") {
            // Inside the transaction window Escape closes the dialog, so the
            // open list has to claim it first.
            if (!open) return;
            e.preventDefault();
            e.stopPropagation();
            revert();
          } else if (e.key === "Tab") {
            if (open) revert();
          }
        }}
        className={`field-inset w-full px-2 py-[4px] text-[12px] placeholder:text-gray-500 ${
          emphasizeEmpty && selectedId == null
            ? "bg-[#fff7dd] font-bold text-class-living"
            : "text-black"
        }`}
      />
      {open && pos && (
        <ul
          id={listId}
          role="listbox"
          aria-label={label ?? ariaLabel ?? "Categories"}
          style={{
            position: "fixed",
            left: pos.left,
            width: pos.width,
            top: pos.top,
            bottom: pos.bottom,
            maxHeight: pos.maxHeight,
          }}
          className="bevel-out z-50 overflow-y-auto overscroll-contain bg-chrome p-[3px] text-[12px]"
        >
          {matches.length === 0 ? (
            <li className="px-2 py-1.5 text-gray-600">
              No category matches “{query.trim()}”.
            </li>
          ) : (
            matches.map((option, i) => {
              const header =
                option.spendingClass &&
                option.spendingClass !== matches[i - 1]?.spendingClass;
              return (
                // `role="presentation"`: the listbox's options are the divs
                // below, and a generic `<li>` in between would break the
                // listbox → option relationship.
                <li key={option.id ?? "none"} role="presentation">
                  {header && (
                    <div
                      role="presentation"
                      className="mt-1 border-b border-chrome-dark px-1 pb-[2px] text-[10px] font-bold uppercase tracking-wide text-gray-700 first:mt-0"
                    >
                      {CLASS_LABELS[option.spendingClass!]}
                    </div>
                  )}
                  <div
                    id={`${listId}-${i}`}
                    role="option"
                    aria-selected={option.id === selectedId}
                    // Selecting on click, but keeping focus: a blur here would
                    // tear the list down before the click ever landed.
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => commit(option)}
                    onMouseEnter={() => setActive(i)}
                    className={`flex cursor-default items-center gap-1.5 px-2 py-[3px] ${
                      i === active
                        ? "bg-primary-700 text-white"
                        : "text-black"
                    }`}
                  >
                    {option.spendingClass ? (
                      <span
                        aria-hidden
                        className={`h-2 w-2 shrink-0 border border-black/30 ${CLASS_DOT_STYLES[option.spendingClass]}`}
                      />
                    ) : (
                      <span aria-hidden className="h-2 w-2 shrink-0" />
                    )}
                    <span className="truncate">{option.name}</span>
                    {option.id === selectedId && (
                      <span aria-hidden className="ml-auto shrink-0">
                        ✓
                      </span>
                    )}
                  </div>
                </li>
              );
            })
          )}
        </ul>
      )}
    </div>
  );
}
