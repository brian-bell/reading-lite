import type { KeyboardEvent, ReactNode } from "react";

// Tabs following the ARIA tabs pattern (design spec, Keyboard, focus, and
// motion): a tablist of buttons with roving tabindex, ArrowLeft/ArrowRight
// with wraparound, Home and End, automatic activation, and a focusable panel.
// The selected key is the caller's state — the reading page keeps it in the
// URL — so this component only reports a selection.
//
// Ids are fixed from `idPrefix` rather than generated, so other controls can
// address a tab (the Source view's "Read summary" button focuses the Summary
// tab) and tests and evidence can find a panel by id.

export interface TabItem<K extends string> {
  key: K;
  label: string;
}

export function tabId(idPrefix: string, key: string): string {
  return `${idPrefix}-tab-${key}`;
}

export function tabPanelId(idPrefix: string, key: string): string {
  return `${idPrefix}-panel-${key}`;
}

export function ViewTabs<K extends string>({
  label,
  idPrefix,
  tabs,
  selected,
  onSelect,
  children,
}: {
  label: string;
  idPrefix: string;
  tabs: readonly TabItem<K>[];
  selected: K;
  onSelect: (key: K) => void;
  children: ReactNode;
}) {
  function select(key: K) {
    if (key !== selected) onSelect(key);
    document.getElementById(tabId(idPrefix, key))?.focus();
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const index = tabs.findIndex((tab) => tab.key === selected);
    let next: number;
    switch (event.key) {
      case "ArrowRight":
        next = (index + 1) % tabs.length;
        break;
      case "ArrowLeft":
        next = (index - 1 + tabs.length) % tabs.length;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = tabs.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    select(tabs[next]!.key);
  }

  return (
    <div className="view-tabs">
      <div role="tablist" aria-label={label} className="tablist" onKeyDown={onKeyDown}>
        {tabs.map((tab) => {
          const active = tab.key === selected;
          return (
            <button
              key={tab.key}
              type="button"
              role="tab"
              id={tabId(idPrefix, tab.key)}
              className="tab"
              aria-selected={active}
              aria-controls={tabPanelId(idPrefix, tab.key)}
              tabIndex={active ? 0 : -1}
              onClick={() => select(tab.key)}
            >
              {tab.label}
            </button>
          );
        })}
      </div>
      <div
        role="tabpanel"
        id={tabPanelId(idPrefix, selected)}
        aria-labelledby={tabId(idPrefix, selected)}
        className="tabpanel"
        tabIndex={0}
      >
        {children}
      </div>
    </div>
  );
}
