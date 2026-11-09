import { useId, type ReactNode } from "react";
import { ChevronDown, Minus, Plus } from "lucide-react";

/*
 * Form fields: one system for every control — a label, the control, an optional hint and error; one height,
 * padding, radius, border, font and focus ring (styles/primitives.css `.control`). `mono` is for values typed
 * character for character as the config and the system know them: names (house, pet, key), tokens and keys, chat
 * and owner ids, hosts. Everything else — titles, aliases, display names, notes, and every select — is in the UI font.
 */

export interface FieldProps {
  /** The control's id, for the label (and the hint and error, by `${id}-hint` / `${id}-error`). */
  id: string;
  label: ReactNode;
  /** Read out but not shown (the field's purpose is plain from what is next to it). */
  hideLabel?: boolean;
  hint?: ReactNode;
  error?: ReactNode;
  /** A caution that does not stop a save (in the danger tone, under the hint). */
  warning?: ReactNode;
  children: ReactNode;
}

/** A label, a control, a hint, a warning, an error. For a control of its own; TextField and SelectField use it. */
export function Field({ id, label, hideLabel, hint, error, warning, children }: FieldProps) {
  return (
    <div className="field">
      <label htmlFor={id} className={hideLabel ? "visually-hidden" : "field-label"}>
        {label}
      </label>
      {children}
      {hint && (
        <p id={`${id}-hint`} className="hint">
          {hint}
        </p>
      )}
      {warning && (
        <p id={`${id}-warning`} className="hint danger">
          {warning}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} className="error">
          {error}
        </p>
      )}
    </div>
  );
}

/** What a control needs from its field: its id, what describes it, whether it is wrong. */
function useControl(hint: ReactNode, error: ReactNode, warning?: ReactNode) {
  const id = useId();
  const described = [hint && `${id}-hint`, warning && `${id}-warning`, error && `${id}-error`].filter(Boolean).join(" ");
  return { id, "aria-describedby": described || undefined, "aria-invalid": error ? true : undefined };
}

interface CommonProps {
  label: ReactNode;
  hideLabel?: boolean;
  hint?: ReactNode;
  error?: ReactNode;
  value: string;
  onChange: (value: string) => void;
}

export interface TextFieldProps extends CommonProps {
  /** A code-like value (see the top of this file). */
  mono?: boolean;
  placeholder?: string;
  readOnly?: boolean;
  maxLength?: number;
  type?: "text" | "search" | "url" | "password";
  inputMode?: "text" | "numeric" | "url";
}

export function TextField({ label, hideLabel, hint, error, value, onChange, mono, ...input }: TextFieldProps) {
  const control = useControl(hint, error);
  return (
    <Field id={control.id} label={label} hideLabel={hideLabel} hint={hint} error={error}>
      <input
        {...control}
        {...input}
        className={mono ? "control mono" : "control"}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        autoComplete="off"
        spellCheck={mono ? false : undefined}
        autoCapitalize={mono ? "off" : undefined}
      />
    </Field>
  );
}

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectFieldProps extends CommonProps {
  options: SelectOption[];
}

/** A select drawn like an input (its own chevron), the same in every browser. */
export function SelectField({ label, hideLabel, hint, error, value, onChange, options }: SelectFieldProps) {
  const control = useControl(hint, error);
  return (
    <Field id={control.id} label={label} hideLabel={hideLabel} hint={hint} error={error}>
      <span className="select">
        <select {...control} className="control" value={value} onChange={(event) => onChange(event.target.value)}>
          {options.map((option) => (
            <option key={option.value} value={option.value} disabled={option.disabled}>
              {option.label}
            </option>
          ))}
        </select>
        <ChevronDown className="chevron" size={16} strokeWidth={1.75} aria-hidden />
      </span>
    </Field>
  );
}

export interface ChoiceOption {
  value: string;
  label: string;
  /** A line on what it is. */
  description?: string;
  /** Its mark, before it. */
  icon?: ReactNode;
}

/** One of a few options, each with a line on it (radio buttons drawn as cards). */
export function ChoiceList({ label, options, value, onChange }: { label: string; options: ChoiceOption[]; value: string; onChange: (value: string) => void }) {
  const name = useId();
  return (
    <fieldset className="field">
      <legend className="field-label">{label}</legend>
      {options.map((option) => (
        <label key={option.value} className="choice">
          <input type="radio" name={name} value={option.value} checked={value === option.value} onChange={() => onChange(option.value)} />
          {option.icon}
          <span className="stack gap-1">
            <span className="strong">{option.label}</span>
            {option.description && <span className="hint">{option.description}</span>}
          </span>
        </label>
      ))}
    </fieldset>
  );
}

export interface CheckOption {
  value: string;
  label: ReactNode;
}

/** Checkboxes under a legend; `empty` says why there are none. */
export function CheckList({ label, options, checked, onToggle, empty }: { label: string; options: CheckOption[]; checked: string[]; onToggle: (value: string) => void; empty?: ReactNode }) {
  return (
    <fieldset className="field">
      <legend className="field-label">{label}</legend>
      {options.length === 0 && empty && <span className="hint">{empty}</span>}
      {options.map((option) => (
        <label key={option.value} className="check">
          <input type="checkbox" checked={checked.includes(option.value)} onChange={() => onToggle(option.value)} />
          <span>{option.label}</span>
        </label>
      ))}
    </fieldset>
  );
}

/** A titled part of a long form (a dialog's «Agent», «Resources»): a line above each one after the first. */
export function FormGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <fieldset className="form-group">
      <legend className="form-group-title">{title}</legend>
      {children}
    </fieldset>
  );
}

/**
 * A number with − and + beside it, its unit after it (and its maximum: «of 10 vCPU»); typed values are kept as typed
 * (the form checks them). `warning` turns it to the danger tone with a line on why, and does not stop a save.
 */
export function StepperField({ label, hint, error, warning, value, onChange, step, min, max, unit }: CommonProps & { warning?: ReactNode; step: number; min: number; max?: number; unit: string }) {
  const control = useControl(hint, error, warning);
  const number = Number(value);
  const by = (delta: number) => {
    const next = Math.round(((Number.isFinite(number) ? number : min) + delta) / step) * step;
    onChange(String(Math.min(max ?? Infinity, Math.max(min, next))));
  };
  return (
    <Field id={control.id} label={label} hint={hint} error={error} warning={warning}>
      <span className={warning ? "stepper danger" : "stepper"}>
        <button type="button" className="icon-btn" aria-label={`Less ${unit}`} onClick={() => by(-step)} disabled={number <= min}>
          <Minus size={14} strokeWidth={2} aria-hidden />
        </button>
        <input {...control} className="control" inputMode="decimal" value={value} onChange={(event) => onChange(event.target.value)} autoComplete="off" />
        <span className="stepper-unit" aria-hidden>{max === undefined ? unit : `of ${max} ${unit}`}</span>
        <button type="button" className="icon-btn" aria-label={`More ${unit}`} onClick={() => by(step)} disabled={max !== undefined && number >= max}>
          <Plus size={14} strokeWidth={2} aria-hidden />
        </button>
      </span>
    </Field>
  );
}

export interface SwitchOption {
  value: string;
  label: ReactNode;
  /** A line on what turning it on does. */
  description?: ReactNode;
}

/** On/off settings in one frame: each its name and a line on it, a switch on the right. */
export function SwitchList({ label, options, on, onToggle, disabled }: { label: string; options: SwitchOption[]; on: string[]; onToggle: (value: string) => void; disabled?: boolean }) {
  return (
    <fieldset className="switch-list">
      <legend className="visually-hidden">{label}</legend>
      {options.map((option) => (
        <label key={option.value} className="switch-row">
          <span className="stack gap-1">
            <span className="strong">{option.label}</span>
            {option.description && <span className="hint">{option.description}</span>}
          </span>
          <input type="checkbox" role="switch" className="switch" checked={on.includes(option.value)} disabled={disabled} onChange={() => onToggle(option.value)} />
        </label>
      ))}
    </fieldset>
  );
}

/**
 * One on/off setting as a switch, its words before it (read out as its name; `hideLabel` when the row around it
 * says what it is). Clicking the words flips it too.
 */
export function Switch({ label, on, onChange, disabled, hideLabel, title }: { label: string; on: boolean; onChange: (on: boolean) => void; disabled?: boolean; hideLabel?: boolean; title?: string }) {
  return (
    <label className="switch-field" title={title}>
      <span className={hideLabel ? "visually-hidden" : undefined}>{label}</span>
      <button type="button" role="switch" aria-checked={on} className="switch" disabled={disabled} onClick={() => onChange(!on)}>
        <span className="switch-knob" />
      </button>
    </label>
  );
}

export function CheckboxField({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: (checked: boolean) => void }) {
  const control = useControl(hint, undefined);
  return <div className="field"><label className="check" htmlFor={control.id}><input {...control} type="checkbox" checked={checked} onChange={event => onChange(event.target.checked)} /><span>{label}</span></label>
    {hint && <p id={`${control.id}-hint`} className="hint">{hint}</p>}</div>;
}
