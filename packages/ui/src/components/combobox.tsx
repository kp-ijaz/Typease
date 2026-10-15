'use client';

import * as React from 'react';
import { Command } from 'cmdk';
import { Check, ChevronsUpDown, Search, X } from 'lucide-react';
import { cn, focusRing } from '../lib/cn';
import { useI18n } from '../i18n/provider';
import { sortedCountries } from '../lib/countries';
import { fieldClasses } from './input';
import { Popover, PopoverContent, PopoverTrigger } from './menus';
import { Spinner } from './spinner';

export interface ComboboxOption {
  value: string;
  label: string;
  /** Second line: a number, an email, a category. Also searched. */
  description?: string;
  /** Extra words to match while typing (other spellings, codes). */
  keywords?: string[];
  disabled?: boolean;
}

export interface ComboboxProps {
  value: string | null | undefined;
  onValueChange: (value: string, option: ComboboxOption | null) => void;
  /** A fixed list, filtered in the browser while typing. */
  options?: ComboboxOption[];
  /**
   * Server-side search for large lists (customers, services): called with the
   * typed text after a short pause; the previous call is aborted.
   */
  loadOptions?: (query: string, signal: AbortSignal) => Promise<ComboboxOption[]>;
  /** With `loadOptions`: the label of the current value, when it is not in the loaded page of results. */
  selectedLabel?: string | null;
  placeholder?: string;
  searchPlaceholder?: string;
  emptyText?: string;
  /** Show a clear button when a value is selected. */
  clearable?: boolean;
  disabled?: boolean;
  id?: string;
  className?: string;
  'aria-invalid'?: boolean | 'true' | 'false';
  'aria-describedby'?: string;
  'aria-label'?: string;
  'aria-labelledby'?: string;
  onBlur?: () => void;
}

/**
 * A searchable dropdown. Use it whenever a list can grow beyond about ten
 * entries (spec section 36: "searchable dropdowns for large lists").
 * Keyboard: type to filter, arrows to move, Enter to choose, Escape to close.
 */
export const Combobox = React.forwardRef<HTMLButtonElement, ComboboxProps>(function Combobox(
  { value, onValueChange, options, loadOptions, selectedLabel, placeholder, searchPlaceholder, emptyText, clearable, disabled, id, className, onBlur, ...aria },
  ref,
) {
  const { t } = useI18n();
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const [loaded, setLoaded] = React.useState<ComboboxOption[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  const known = React.useRef(new Map<string, ComboboxOption>());
  const listId = React.useId();

  const load = React.useRef(loadOptions);
  load.current = loadOptions;
  const isAsync = !!loadOptions;

  React.useEffect(() => {
    if (!open || !load.current) return;
    const controller = new AbortController();
    setLoading(true);
    setFailed(false);
    const timer = window.setTimeout(
      () => {
        load
          .current?.(query.trim(), controller.signal)
          .then((result) => {
            if (controller.signal.aborted) return;
            for (const o of result) known.current.set(o.value, o);
            setLoaded(result);
            setLoading(false);
          })
          .catch(() => {
            if (controller.signal.aborted) return;
            setFailed(true);
            setLoading(false);
          });
      },
      query ? 250 : 0,
    );
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [open, query]);

  const list = isAsync ? loaded : options ?? [];
  const selected = value ? list.find((o) => o.value === value) ?? known.current.get(value) ?? (options ?? []).find((o) => o.value === value) : undefined;
  const display = selected?.label ?? (value ? selectedLabel ?? value : '');

  const choose = (option: ComboboxOption) => {
    known.current.set(option.value, option);
    onValueChange(option.value, option);
    setOpen(false);
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setQuery('');
          onBlur?.();
        }
      }}
    >
      <div className={cn('relative w-full', className)}>
        <PopoverTrigger asChild>
          <button
            ref={ref}
            id={id}
            type="button"
            role="combobox"
            aria-expanded={open}
            aria-controls={listId}
            aria-haspopup="listbox"
            disabled={disabled}
            className={cn(fieldClasses, 'h-10 items-center justify-between gap-2 text-start')}
            {...aria}
          >
            <span className={cn('truncate', !display && 'text-muted-foreground', clearable && value && 'me-7')}>{display || placeholder || t('common.selectPlaceholder')}</span>
            <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          </button>
        </PopoverTrigger>
        {clearable && value && !disabled ? (
          <button
            type="button"
            aria-label={t('common.clear')}
            onClick={() => onValueChange('', null)}
            className={cn('absolute end-8 top-1/2 inline-flex size-7 -translate-y-1/2 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground', focusRing)}
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        ) : null}
      </div>
      <PopoverContent className="w-[var(--radix-popover-trigger-width)] min-w-64 p-0" align="start">
        <Command shouldFilter={!isAsync} loop label={placeholder ?? t('common.search')}>
          <div className="flex items-center gap-2 border-b px-3">
            <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <Command.Input
              value={query}
              onValueChange={setQuery}
              placeholder={searchPlaceholder ?? t('common.typeToSearch')}
              className="h-11 w-full bg-transparent text-md outline-none placeholder:text-muted-foreground sm:text-base"
            />
            {loading ? <Spinner size="sm" className="text-muted-foreground" /> : null}
          </div>
          <Command.List id={listId} className="scroll-quiet max-h-64 overflow-y-auto p-1">
            {failed ? <p className="px-3 py-6 text-center text-sm text-destructive-text">{t('errors.network')}</p> : null}
            {!failed && !(isAsync && loading && list.length === 0) ? (
              <Command.Empty className="px-3 py-6 text-center text-sm text-muted-foreground">{query ? emptyText ?? t('common.noResultsFor', { query }) : emptyText ?? t('common.noResults')}</Command.Empty>
            ) : null}
            {list.map((option) => (
              <Command.Item
                key={option.value}
                value={isAsync ? option.value : `${option.label} ${option.description ?? ''} ${option.value}`}
                keywords={option.keywords}
                disabled={option.disabled}
                onSelect={() => choose(option)}
                className="relative flex min-h-9 cursor-default select-none items-center gap-2 rounded-sm py-1.5 pe-8 ps-2.5 text-base outline-none data-[disabled=true]:pointer-events-none data-[selected=true]:bg-muted data-[disabled=true]:opacity-50"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{option.label}</span>
                  {option.description ? <span className="block truncate text-sm text-muted-foreground">{option.description}</span> : null}
                </span>
                {option.value === value ? <Check className="absolute end-2 size-4 text-secondary-text" aria-hidden="true" /> : null}
              </Command.Item>
            ))}
          </Command.List>
        </Command>
      </PopoverContent>
    </Popover>
  );
});

/** A country picker (ISO 3166 alpha-2 values) in the active language, common nationalities first. */
export const CountrySelect = React.forwardRef<HTMLButtonElement, Omit<ComboboxProps, 'options' | 'loadOptions' | 'selectedLabel'>>(function CountrySelect(props, ref) {
  const { locale } = useI18n();
  const options = React.useMemo(() => sortedCountries(locale).map((c) => ({ value: c.code, label: c.name, keywords: [c.code, `+${c.dial}`] })), [locale]);
  return <Combobox ref={ref} options={options} clearable {...props} />;
});
