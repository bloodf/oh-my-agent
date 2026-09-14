/**
 * Purpose: Small form controls the agent settings sections share — a labelled
 * field, a checkbox row, a list of string chips with free entry and
 * suggestions, and the native select styling the console already uses.
 *
 * Public API: `Field`, `CheckRow`, `ChipList`, `SELECT_CLASS`, `SectionTitle`.
 *
 * Upstream deps: shadcn Label, Input, Checkbox, Button.
 *
 * Downstream consumers: `./sections.tsx`.
 */
import { useId, useState, type ReactNode } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export const SELECT_CLASS =
  "h-9 w-full min-w-0 rounded-md border border-input bg-background px-3 text-[15px] outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-50";

export function SectionTitle({ title, description }: { title: string; description: string }) {
  return (
    <header className="grid gap-1">
      <h3 className="text-lg font-bold">{title}</h3>
      <p className="text-[13px] text-muted-foreground">{description}</p>
    </header>
  );
}

export function Field({ id, label, hint, optional, children, className = "" }: {
  id: string;
  label: string;
  hint?: ReactNode;
  optional?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`grid min-w-0 content-start gap-1.5 ${className}`}>
      <Label htmlFor={id}>
        {label}
        {optional && <span className="font-normal text-muted-foreground">(optional)</span>}
      </Label>
      {children}
      {hint && <p className="text-[13px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

export function CheckRow({ id, label, hint, checked, onChange, disabled }: {
  id: string;
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex min-h-11 items-start gap-3 rounded-lg border px-3 py-2.5">
      <Checkbox id={id} className="mt-0.5" checked={checked} disabled={disabled} onCheckedChange={(value) => onChange(value === true)} />
      <div className="grid gap-0.5">
        <Label htmlFor={id} className="font-semibold">{label}</Label>
        {hint && <p className="text-[13px] text-muted-foreground">{hint}</p>}
      </div>
    </div>
  );
}

/**
 * A list of strings as removable chips. Enter or a comma adds what is typed;
 * suggestions come from a native datalist, so any value may still be entered.
 */
export function ChipList({ id, label, values, onChange, suggestions = [], placeholder, disabled }: {
  id: string;
  label: string;
  values: string[];
  onChange: (values: string[]) => void;
  suggestions?: string[];
  placeholder?: string;
  disabled?: boolean;
}) {
  const [text, setText] = useState("");
  const listId = useId();
  const add = () => {
    const entries = text.split(",").map((entry) => entry.trim()).filter(Boolean);
    if (entries.length) onChange([...new Set([...values, ...entries])]);
    setText("");
  };
  const open = suggestions.filter((entry) => !values.includes(entry));
  return (
    <div className="grid min-w-0 gap-2">
      {values.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label={label}>
          {values.map((value) => (
            <li key={value} className="inline-flex h-7 max-w-full items-center gap-1 rounded-md border bg-muted pr-0.5 pl-2 font-mono text-[13px]">
              <span className="truncate">{value}</span>
              <Button type="button" variant="ghost" size="icon-xs" className="size-6 max-sm:size-8" aria-label={`Remove ${value}`} disabled={disabled} onClick={() => onChange(values.filter((entry) => entry !== value))}>
                <X />
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex min-w-0 gap-2">
        <Input
          id={id}
          list={open.length ? listId : undefined}
          placeholder={placeholder}
          value={text}
          disabled={disabled}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === ",") {
              event.preventDefault();
              add();
            }
          }}
          onBlur={add}
        />
        <Button type="button" variant="outline" className="h-9 max-sm:h-11" disabled={disabled || !text.trim()} onClick={add}>Add</Button>
      </div>
      {open.length > 0 && (
        <datalist id={listId}>
          {open.map((entry) => <option key={entry} value={entry} />)}
        </datalist>
      )}
    </div>
  );
}
