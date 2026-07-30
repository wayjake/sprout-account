import { useEffect, useId, useRef, useState } from "react";
import { Link } from "react-router";

/**
 * The window menu bar. Looks like 1999, behaves like the ARIA menubar pattern:
 * one Tab stop, arrows to move, Enter/Space to activate, Escape to close and
 * return focus to the menu title.
 *
 * Items that lead somewhere are real `<Link>`s so ⌘-click still opens a new
 * tab. Items marked `unavailable` are the nostalgic ones — greyed, announced
 * as disabled, still reachable by arrow keys so nobody has to wonder whether
 * they missed something.
 */
export type MenuEntry =
  | { kind: "separator" }
  | { kind: "link"; label: string; to: string }
  | { kind: "action"; label: string; onSelect: () => void }
  | { kind: "unavailable"; label: string; note: string };

export interface MenuDef {
  label: string;
  items: MenuEntry[];
}

/** Indices of the entries arrow keys are allowed to land on (i.e. not rules). */
function focusableIndices(items: MenuEntry[]): number[] {
  return items.reduce<number[]>((acc, item, i) => {
    if (item.kind !== "separator") acc.push(i);
    return acc;
  }, []);
}

export function MenuBar({ menus }: { menus: MenuDef[] }) {
  const [openMenu, setOpenMenu] = useState<number | null>(null);
  const [activeItem, setActiveItem] = useState<number | null>(null);
  // Roving tabindex: the menu bar is a single Tab stop.
  const [tabStop, setTabStop] = useState(0);
  const barRef = useRef<HTMLDivElement>(null);
  const titleRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const itemRefs = useRef<(HTMLElement | null)[]>([]);
  const baseId = useId();

  function close(refocus?: number) {
    setOpenMenu(null);
    setActiveItem(null);
    if (refocus != null) titleRefs.current[refocus]?.focus();
  }

  function open(index: number, item: "first" | "last" | null) {
    const items = menus[index].items;
    const focusable = focusableIndices(items);
    setOpenMenu(index);
    setTabStop(index);
    setActiveItem(
      item === "first"
        ? (focusable[0] ?? null)
        : item === "last"
          ? (focusable[focusable.length - 1] ?? null)
          : null,
    );
  }

  // Move real DOM focus to whichever item the arrow keys selected.
  useEffect(() => {
    if (openMenu == null || activeItem == null) return;
    itemRefs.current[activeItem]?.focus();
  }, [openMenu, activeItem]);

  // Click anywhere else puts the menu away, as it should.
  useEffect(() => {
    if (openMenu == null) return;
    function onPointerDown(event: PointerEvent) {
      if (!barRef.current?.contains(event.target as Node)) close();
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [openMenu]);

  function moveWithin(delta: number) {
    if (openMenu == null || activeItem == null) return;
    const focusable = focusableIndices(menus[openMenu].items);
    const at = focusable.indexOf(activeItem);
    const next = (at + delta + focusable.length) % focusable.length;
    setActiveItem(focusable[next]);
  }

  function onTitleKeyDown(event: React.KeyboardEvent, index: number) {
    switch (event.key) {
      case "ArrowDown":
      case "Enter":
      case " ":
        event.preventDefault(); // also suppresses the click Enter/Space would fire
        open(index, "first");
        break;
      case "ArrowUp":
        event.preventDefault();
        open(index, "last");
        break;
      case "ArrowRight":
      case "ArrowLeft": {
        event.preventDefault();
        const delta = event.key === "ArrowRight" ? 1 : -1;
        const next = (index + delta + menus.length) % menus.length;
        setTabStop(next);
        if (openMenu != null) open(next, null);
        titleRefs.current[next]?.focus();
        break;
      }
      case "Escape":
        if (openMenu != null) {
          event.preventDefault();
          close(index);
        }
        break;
      case "Home":
      case "End": {
        event.preventDefault();
        const next = event.key === "Home" ? 0 : menus.length - 1;
        setTabStop(next);
        titleRefs.current[next]?.focus();
        break;
      }
    }
  }

  function onItemKeyDown(event: React.KeyboardEvent, menuIndex: number) {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        moveWithin(1);
        break;
      case "ArrowUp":
        event.preventDefault();
        moveWithin(-1);
        break;
      case "Home":
      case "End": {
        event.preventDefault();
        const focusable = focusableIndices(menus[menuIndex].items);
        setActiveItem(event.key === "Home" ? focusable[0] : focusable.at(-1)!);
        break;
      }
      case "ArrowRight":
      case "ArrowLeft": {
        event.preventDefault();
        const delta = event.key === "ArrowRight" ? 1 : -1;
        open((menuIndex + delta + menus.length) % menus.length, "first");
        break;
      }
      case "Escape":
        event.preventDefault();
        close(menuIndex);
        break;
      case "Tab":
        close(); // let Tab carry on out of the menu bar
        break;
      case " ":
        // Enter activates a link natively; Space does not.
        if (event.currentTarget instanceof HTMLAnchorElement) {
          event.preventDefault();
          event.currentTarget.click();
        }
        break;
    }
  }

  return (
    <div
      ref={barRef}
      role="menubar"
      aria-label="Application menu"
      className="flex gap-0 border-b border-chrome-dark/40 bg-chrome px-1 py-[2px] text-[12px]"
      onBlur={(event) => {
        // Focus left the menu bar entirely (Tab, or a click elsewhere).
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setOpenMenu(null);
          setActiveItem(null);
        }
      }}
    >
      {menus.map((menu, index) => {
        const isOpen = openMenu === index;
        return (
          <div key={menu.label} className="relative">
            <button
              ref={(el) => {
                titleRefs.current[index] = el;
              }}
              type="button"
              role="menuitem"
              aria-haspopup="menu"
              aria-expanded={isOpen}
              aria-controls={isOpen ? `${baseId}-menu-${index}` : undefined}
              tabIndex={tabStop === index ? 0 : -1}
              data-open={isOpen}
              className="menu-item menu-title"
              onClick={() => (isOpen ? close() : open(index, null))}
              onPointerEnter={() => {
                // With a menu already down, sliding sideways switches menus.
                if (openMenu != null && openMenu !== index) open(index, null);
              }}
              onFocus={() => setTabStop(index)}
              onKeyDown={(event) => onTitleKeyDown(event, index)}
            >
              <span className="underline">{menu.label[0]}</span>
              {menu.label.slice(1)}
            </button>

            {isOpen && (
              <div
                id={`${baseId}-menu-${index}`}
                role="menu"
                aria-label={menu.label}
                className="menu-popup absolute left-0 top-full z-40 min-w-[13rem] p-[3px]"
              >
                {menu.items.map((item, itemIndex) => {
                  if (item.kind === "separator") {
                    return (
                      <div key={`sep-${itemIndex}`} role="separator" className="menu-sep" />
                    );
                  }

                  const shared = {
                    role: "menuitem" as const,
                    tabIndex: -1,
                    className: "menu-row",
                    onKeyDown: (event: React.KeyboardEvent) =>
                      onItemKeyDown(event, index),
                    ref: (el: HTMLElement | null) => {
                      itemRefs.current[itemIndex] = el;
                    },
                  };

                  if (item.kind === "unavailable") {
                    return (
                      <span
                        {...shared}
                        key={item.label}
                        aria-disabled="true"
                        className="menu-row menu-row-off"
                        title={item.note}
                      >
                        {item.label}
                      </span>
                    );
                  }

                  if (item.kind === "action") {
                    return (
                      <button
                        {...shared}
                        key={item.label}
                        type="button"
                        onClick={() => {
                          close(index);
                          item.onSelect();
                        }}
                      >
                        {item.label}
                      </button>
                    );
                  }

                  return (
                    <Link
                      {...shared}
                      key={item.label}
                      to={item.to}
                      // Close first, so focus is back on the menu title before
                      // navigation — a pane opening from here can then restore
                      // focus to something that still exists.
                      onClick={() => close(index)}
                    >
                      {item.label}
                    </Link>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
