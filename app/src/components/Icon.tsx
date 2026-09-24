// Stroke icons from the Connected prototype (study.tsx at the frozen source
// commit in docs/design/connected/README.md). Decorative only.
const paths = {
  library: "M4 4h4v16H4z M10 4h4v16h-4z M16 5l3-1 4 15-3 1z",
  plus: "M12 5v14 M5 12h14",
  sun: "M12 8a4 4 0 1 1 0 8 4 4 0 0 1 0-8 M12 1v3 M12 20v3 M1 12h3 M20 12h3 M4 4l2 2 M18 18l2 2 M4 20l2-2 M18 6l2-2",
  moon: "M20 15A9 9 0 0 1 9 4a9 9 0 1 0 11 11",
  desktop: "M3 3h18v13H3z M12 16v5 M7 21h10",
  user: "M12 4a4 4 0 1 1 0 8 4 4 0 0 1 0-8 M4 21a8 8 0 0 1 16 0",
  close: "M6 6l12 12 M18 6L6 18",
} as const;

export type IconName = keyof typeof paths;

/**
 * `strokeWidth` is in viewBox units (24): 1.5 by default, beside regular text.
 * A small icon beside small text passes a heavier one so it keeps the text's
 * weight once scaled down.
 */
export function Icon({ name, size = 18, strokeWidth = 1.5 }: { name: IconName; size?: number; strokeWidth?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={paths[name]} />
    </svg>
  );
}
