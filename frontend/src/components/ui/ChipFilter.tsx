import styles from './ui.module.css';

interface ChipFilterProps<Value extends string> {
  label: string;
  options: readonly { value: Value; label: string }[];
  selected: Value;
  onSelect: (value: Value) => void;
}

export function ChipFilter<Value extends string>({ label, options, selected, onSelect }: ChipFilterProps<Value>) {
  return (
    <div className={styles.chips} role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className={styles.chip}
          aria-pressed={option.value === selected}
          onClick={() => onSelect(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
