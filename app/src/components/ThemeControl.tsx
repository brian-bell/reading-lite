import type { ThemePreference } from "../theme";
import { Icon, type IconName } from "./Icon";

const options: ReadonlyArray<{ value: ThemePreference; label: string; icon: IconName }> = [
  { value: "system", label: "System", icon: "desktop" },
  { value: "light", label: "Light", icon: "sun" },
  { value: "dark", label: "Dark", icon: "moon" },
];

export function ThemeControl({
  value,
  onChange,
}: {
  value: ThemePreference;
  onChange: (next: ThemePreference) => void;
}) {
  return (
    <div className="theme-control" role="radiogroup" aria-labelledby="theme-control-label">
      <span id="theme-control-label" className="theme-control-label">
        Theme
      </span>
      {options.map((option) => (
        <label key={option.value} className="theme-option" title={option.label}>
          <input
            type="radio"
            name="theme"
            value={option.value}
            checked={value === option.value}
            onChange={() => onChange(option.value)}
          />
          <Icon name={option.icon} size={16} />
          <span>{option.label}</span>
        </label>
      ))}
    </div>
  );
}
