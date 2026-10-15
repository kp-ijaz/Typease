'use client';

import * as React from 'react';
import { Eye, EyeOff, Search, X } from 'lucide-react';
import { cn, focusRing } from '../lib/cn';
import { useI18n } from '../i18n/provider';
import { COUNTRIES, countryName } from '../lib/countries';
import { isIsoDate } from '../lib/format';
import { normaliseMoney, sanitiseMoneyInput } from '../lib/money';
import { DEFAULT_DIAL_CODE, joinPhone, splitPhone } from '../lib/phone';
import { Input, fieldClasses, type InputProps } from './input';

// ---------------------------------------------------------------- PasswordInput

export const PasswordInput = React.forwardRef<HTMLInputElement, Omit<InputProps, 'type' | 'endAdornment'>>(function PasswordInput(props, ref) {
  const { t } = useI18n();
  const [visible, setVisible] = React.useState(false);
  return (
    <Input
      ref={ref}
      type={visible ? 'text' : 'password'}
      autoComplete="current-password"
      {...props}
      endAdornment={
        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          aria-pressed={visible}
          aria-label={visible ? t('form.hidePassword') : t('form.showPassword')}
          className={cn('inline-flex size-8 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground', focusRing)}
        >
          {visible ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
        </button>
      }
    />
  );
});

// ---------------------------------------------------------------- SearchInput

export interface SearchInputProps extends Omit<InputProps, 'value' | 'onChange' | 'type'> {
  value: string;
  /** Called after the person stops typing for `debounceMs` (and immediately on clear / Enter). */
  onChange: (value: string) => void;
  debounceMs?: number;
}

/** A search field that reports its value after a short pause, so lists are not refetched on every key. */
export const SearchInput = React.forwardRef<HTMLInputElement, SearchInputProps>(function SearchInput({ value, onChange, debounceMs = 300, placeholder, className, ...props }, ref) {
  const { t } = useI18n();
  const [text, setText] = React.useState(value);
  const latest = React.useRef(onChange);
  latest.current = onChange;
  const sent = React.useRef(value);

  // Follow changes from outside (cleared filters, URL navigation).
  React.useEffect(() => {
    if (value !== sent.current) {
      sent.current = value;
      setText(value);
    }
  }, [value]);

  React.useEffect(() => {
    if (text === sent.current) return;
    const timer = window.setTimeout(() => {
      sent.current = text;
      latest.current(text);
    }, debounceMs);
    return () => window.clearTimeout(timer);
  }, [text, debounceMs]);

  const flush = (next: string) => {
    setText(next);
    sent.current = next;
    latest.current(next);
  };

  return (
    <Input
      ref={ref}
      type="search"
      role="searchbox"
      enterKeyHint="search"
      autoComplete="off"
      value={text}
      placeholder={placeholder ?? t('common.searchPlaceholder')}
      onChange={(e) => setText(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') flush(text);
        if (e.key === 'Escape' && text) {
          e.preventDefault();
          flush('');
        }
      }}
      startAdornment={<Search aria-hidden="true" />}
      endAdornment={
        text ? (
          <button type="button" onClick={() => flush('')} aria-label={t('common.clear')} className={cn('inline-flex size-8 items-center justify-center rounded-sm hover:text-foreground', focusRing)}>
            <X aria-hidden="true" />
          </button>
        ) : undefined
      }
      className={cn('[&::-webkit-search-cancel-button]:hidden', className)}
      {...props}
    />
  );
});

// ---------------------------------------------------------------- DatePicker

export interface DatePickerProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type' | 'min' | 'max'> {
  /** A calendar date as "YYYY-MM-DD" (or "" / null for none). Never a Date object: no time zone can shift it. */
  value: string | null | undefined;
  onChange: (value: string) => void;
  min?: string;
  max?: string;
}

/**
 * A date field built on the browser's native picker: familiar on every phone,
 * keyboard-accessible, and localised by the browser. The value is the plain
 * "YYYY-MM-DD" string the API uses for calendar dates (expiry, date of birth).
 */
export const DatePicker = React.forwardRef<HTMLInputElement, DatePickerProps>(function DatePicker({ value, onChange, min, max, className, ...props }, ref) {
  return (
    <input
      ref={ref}
      type="date"
      value={value && isIsoDate(value) ? value : ''}
      min={min}
      max={max}
      onChange={(e) => onChange(e.target.value)}
      className={cn(fieldClasses, 'h-10 min-w-36', !value && 'text-muted-foreground', className)}
      {...props}
    />
  );
});

// ---------------------------------------------------------------- MoneyInput

export interface MoneyInputProps extends Omit<InputProps, 'value' | 'onChange' | 'type' | 'inputMode'> {
  /** Decimal string such as "150.00". Never a number. */
  value: string | null | undefined;
  onChange: (value: string) => void;
  /** ISO code shown inside the field. Defaults to the centre's currency. */
  currency?: string;
}

/**
 * An amount field. Keeps the value as a decimal STRING (what the API expects),
 * accepts Arabic digits and pasted "1,250.50", cuts after two decimals, and
 * pads to two decimals when the field is left.
 */
export const MoneyInput = React.forwardRef<HTMLInputElement, MoneyInputProps>(function MoneyInput({ value, onChange, onBlur, currency, className, placeholder = '0.00', ...props }, ref) {
  const i18n = useI18n();
  return (
    <Input
      ref={ref}
      inputMode="decimal"
      autoComplete="off"
      dir="ltr"
      placeholder={placeholder}
      value={value ?? ''}
      onChange={(e) => onChange(sanitiseMoneyInput(e.target.value))}
      onBlur={(e) => {
        const normalised = normaliseMoney(e.target.value);
        if (normalised !== (value ?? '')) onChange(normalised);
        onBlur?.(e);
      }}
      startAdornment={<span className="text-sm font-medium">{currency ?? i18n.currency}</span>}
      className={cn('tabular ps-14 text-end', className)}
      {...props}
    />
  );
});

// ---------------------------------------------------------------- PhoneInput

export interface PhoneInputProps extends Omit<InputProps, 'value' | 'onChange' | 'type' | 'startAdornment' | 'endAdornment'> {
  /** E.164, e.g. "+971501234567" ("" for none). */
  value: string | null | undefined;
  onChange: (value: string) => void;
  /** Dialling code used for an empty field. */
  defaultDialCode?: string;
}

const DIAL_OPTIONS = Array.from(new Map(COUNTRIES.map((c) => [c.dial, c])).values());

/**
 * A phone field that always produces E.164. The person picks the country code
 * (default +971) and types the number the way they know it; a leading 0 and
 * spaces are removed. Pasting a full international number sets the code too.
 */
export const PhoneInput = React.forwardRef<HTMLInputElement, PhoneInputProps>(function PhoneInput(
  { value, onChange, defaultDialCode = DEFAULT_DIAL_CODE, className, id, disabled, placeholder, 'aria-invalid': invalid, ...props },
  ref,
) {
  const { t, locale } = useI18n();
  const initial = splitPhone(value, defaultDialCode);
  const [dial, setDial] = React.useState(initial.dial);
  const [typed, setTyped] = React.useState(initial.national);

  // Follow values set from outside (form reset, loading a record) without disturbing typing.
  React.useEffect(() => {
    const external = value ?? '';
    if (external !== joinPhone(dial, typed)) {
      const next = splitPhone(external, dial || defaultDialCode);
      setDial(next.dial);
      setTyped(next.national);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const emit = (nextDial: string, nextTyped: string) => {
    const full = joinPhone(nextDial, nextTyped);
    // A pasted international number: adopt its country code.
    if (/^(\+|00)/.test(nextTyped.trim())) {
      const split = splitPhone(full, nextDial);
      setDial(split.dial);
      setTyped(split.national);
    } else {
      setDial(nextDial);
      setTyped(nextTyped);
    }
    onChange(full);
  };

  // Country names come from Intl, whose data differs between the server's Node and the browser.
  // The list is therefore built after mount; the server renders only the selected code.
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => setMounted(true), []);
  const options = React.useMemo(
    () =>
      mounted
        ? DIAL_OPTIONS.map((c) => ({ dial: c.dial, label: `${countryName(c.code, locale)} (+${c.dial})` })).sort((a, b) => (a.dial === DEFAULT_DIAL_CODE ? -1 : b.dial === DEFAULT_DIAL_CODE ? 1 : a.label.localeCompare(b.label, locale)))
        : [{ dial, label: `+${dial}` }],
    [locale, mounted, dial],
  );

  return (
    <div dir="ltr" className={cn('flex w-full', className)}>
      <div className="relative shrink-0">
        <select
          aria-label={t('form.countryCode')}
          value={dial}
          disabled={disabled}
          onChange={(e) => emit(e.target.value, typed)}
          className={cn(fieldClasses, 'h-10 w-[5.25rem] cursor-pointer appearance-none rounded-e-none border-e-0 pe-2 ps-3 text-transparent focus-visible:z-10')}
        >
          {options.map((o) => (
            <option key={o.dial} value={o.dial} className="text-foreground">
              {o.label}
            </option>
          ))}
        </select>
        <span aria-hidden="true" className="tabular pointer-events-none absolute inset-0 flex items-center justify-center text-base text-foreground">
          +{dial}
        </span>
      </div>
      <input
        ref={ref}
        id={id}
        type="tel"
        inputMode="tel"
        autoComplete="tel-national"
        disabled={disabled}
        aria-invalid={invalid}
        placeholder={placeholder ?? '50 123 4567'}
        value={typed}
        onChange={(e) => emit(dial, e.target.value)}
        className={cn(fieldClasses, 'tabular h-10 flex-1 rounded-s-none focus-visible:z-10')}
        {...props}
      />
    </div>
  );
});
