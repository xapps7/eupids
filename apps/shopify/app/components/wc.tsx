// Polaris web components fire native DOM events. React 18 does not wire onChange for
// custom elements, so we listen directly. Works the same on React 19.
import { useEffect, useRef, type ReactNode } from "react";

export function useWcEvents<T extends HTMLElement>(handler: (el: T, e: Event) => void, events = ["input", "change"]) {
  const ref = useRef<T>(null);
  const latest = useRef(handler);
  latest.current = handler;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const h = (e: Event) => latest.current(el, e);
    for (const ev of events) el.addEventListener(ev, h);
    return () => {
      for (const ev of events) el.removeEventListener(ev, h);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events.join(",")]);
  return ref;
}

type FieldProps = {
  label: string;
  value: string;
  onValue: (v: string) => void;
  error?: string | null;
  details?: string;
  placeholder?: string;
  disabled?: boolean;
  id?: string;
};

export function TextField({ label, value, onValue, error, details, placeholder, disabled, id }: FieldProps) {
  const ref = useWcEvents<HTMLElement>((el) => onValue(String((el as any).value ?? "")));
  // Keep the element's value in sync when state changes from outside (reset, suggestion).
  useEffect(() => {
    const el = ref.current as any;
    if (el && el.value !== value) el.value = value;
  }, [value, ref]);
  return (
    <s-text-field
      ref={ref as any}
      id={id}
      label={label}
      value={value}
      {...(error ? { error } : {})}
      {...(details ? { details } : {})}
      {...(placeholder ? { placeholder } : {})}
      {...(disabled ? { disabled: true } : {})}
    />
  );
}

export function Checkbox({ label, checked, onChecked, disabled, details, hideLabel }: { label: string; checked: boolean; onChecked: (v: boolean) => void; disabled?: boolean; details?: string; hideLabel?: boolean }) {
  const ref = useWcEvents<HTMLElement>((el) => onChecked(!!(el as any).checked), ["change"]);
  useEffect(() => {
    const el = ref.current as any;
    if (el && el.checked !== checked) el.checked = checked;
  }, [checked, ref]);
  return <s-checkbox ref={ref as any} label={label} {...(hideLabel ? { labelAccessibilityVisibility: "exclusive" } : {})} {...(checked ? { checked: true } : {})} {...(disabled ? { disabled: true } : {})} {...(details ? { details } : {})} />;
}

export function Select({ label, value, onValue, options, labelAccessibilityVisibility }: { label: string; value: string; onValue: (v: string) => void; options: { value: string; label: string }[]; labelAccessibilityVisibility?: "visible" | "exclusive" }) {
  const ref = useWcEvents<HTMLElement>((el) => onValue(String((el as any).value ?? "")), ["change"]);
  useEffect(() => {
    const el = ref.current as any;
    if (el && el.value !== value) el.value = value;
  }, [value, ref]);
  return (
    <s-select ref={ref as any} label={label} value={value} {...(labelAccessibilityVisibility ? { labelAccessibilityVisibility } : {})}>
      {options.map((o) => (
        <s-option key={o.value} value={o.value}>
          {o.label}
        </s-option>
      ))}
    </s-select>
  );
}

export function Switch({ label, checked, onChecked, details }: { label: string; checked: boolean; onChecked: (v: boolean) => void; details?: string }) {
  const ref = useWcEvents<HTMLElement>((el) => onChecked(!!(el as any).checked), ["change"]);
  useEffect(() => {
    const el = ref.current as any;
    if (el && el.checked !== checked) el.checked = checked;
  }, [checked, ref]);
  return <s-switch ref={ref as any} label={label} {...(checked ? { checked: true } : {})} {...(details ? { details } : {})} />;
}

export function Mono({ children }: { children: ReactNode }) {
  return <code style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 12.5, background: "var(--s-color-bg-surface-secondary, #f3f3f3)", padding: "1px 5px", borderRadius: 4, wordBreak: "break-all" }}>{children}</code>;
}
