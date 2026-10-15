/**
 * Tests for defects found by the teams building on the shared foundation.
 * Each block names the defect it guards against.
 */
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { z } from 'zod';
import { ApiError, errorFromResponse } from '@typease/api-client';
import type { Page } from '@typease/types';
import { I18nProvider, hasKey, mergeDictionaries, translate, uiDictionaries, type Dictionaries } from '../i18n';
import { ThemeProvider } from '../providers/theme';
import { DataTable, type DataTablePageInfo } from '../data-table/data-table';
import { describeError } from '../lib/errors';
import { statusMeta } from '../lib/status-meta';
import { Form, FormField, useZodForm } from './form';
import { Input } from './input';
import { Select } from './select';

function wrap(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree = (node: React.ReactElement) => (
    <I18nProvider locale="en" dictionaries={uiDictionaries}>
      <ThemeProvider>
        <QueryClientProvider client={client}>{node}</QueryClientProvider>
      </ThemeProvider>
    </I18nProvider>
  );
  const view = render(tree(ui));
  return { ...view, rerender: (node: React.ReactElement) => view.rerender(tree(node)) };
}

let errors: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  errors.mockRestore();
  window.history.replaceState(null, '', '/');
});

// ---------------------------------------------------------------------------------------------------------------------
describe('Select: one owner for the value label', () => {
  const options = [
    { value: 'en', label: 'English' },
    { value: 'ar', label: 'Arabic' },
  ];

  it('renders the label itself and gives Radix no node to portal into (the cause of the React 19 container error)', () => {
    const { rerender } = wrap(<Select aria-label="Language" value="" options={options} placeholder="Choose" onValueChange={() => undefined} />);
    const trigger = screen.getByRole('combobox', { name: 'Language' });
    const value = () => trigger.querySelector('[data-slot="select-value"]') as HTMLElement;
    expect(value().textContent).toBe('Choose');
    // Radix's <Select.Value> is a span with an inline `pointer-events: none`; it must not exist.
    expect(trigger.querySelector('span[style*="pointer-events"]')).toBeNull();

    // empty -> set: the moment the defect showed up
    rerender(<Select aria-label="Language" value="ar" options={options} placeholder="Choose" onValueChange={() => undefined} />);
    expect(value().textContent).toBe('Arabic');
    expect(value().childElementCount).toBe(0);
    expect(errors).not.toHaveBeenCalled();
  });

  it('opens with a value selected, without console errors, and marks the selected option', async () => {
    wrap(<Select aria-label="Language" value="ar" options={options} onValueChange={() => undefined} />);
    const trigger = screen.getByRole('combobox', { name: 'Language' });
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    const selected = await screen.findByRole('option', { name: 'Arabic' });
    expect(selected.getAttribute('aria-selected')).toBe('true');
    // The label is still written once in the trigger: nothing was portalled next to it.
    expect(trigger.querySelector('[data-slot="select-value"]')?.textContent).toBe('Arabic');
    expect(errors).not.toHaveBeenCalled();
  });

  it('ignores the empty-string change Radix echoes from its hidden native select', () => {
    const onValueChange = vi.fn();
    const { container } = wrap(
      <form>
        <Select aria-label="Language" name="language" value="ar" options={options} onValueChange={onValueChange} />
      </form>,
    );
    const native = container.querySelector('select[aria-hidden="true"]') as HTMLSelectElement;
    expect(native).toBeTruthy();
    // What the browser does when the value is set from outside before the matching <option> exists.
    fireEvent.change(native, { target: { value: '' } });
    expect(onValueChange).not.toHaveBeenCalled();
    // A real choice still gets through.
    fireEvent.change(native, { target: { value: 'en' } });
    expect(onValueChange).toHaveBeenCalledWith('en');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('DataTable: stable state, row click, filters from outside, page info', () => {
  interface Row {
    id: string;
    name: string;
  }
  const page = (rows: Row[], total = rows.length, pageNo = 1): Page<Row> => ({ data: rows, meta: { page: pageNo, pageSize: 20, total, totalPages: Math.max(1, Math.ceil(total / 20)) } });
  const columns = [
    { id: 'name', header: 'Name', cell: (r: Row) => r.name, mobile: 'title' as const },
    { id: 'id', header: 'No.', cell: (r: Row) => r.id },
  ];
  const rows = [
    { id: '1', name: 'Ahmed Khalid' },
    { id: '2', name: 'Sara Mohammed' },
  ];

  it('does not restart its URL sync on every render when no filters are given ("Maximum update depth exceeded")', async () => {
    const queryFn = vi.fn(async (_params: Record<string, unknown>) => page(rows));
    let renders = 0;
    function Counting() {
      renders += 1;
      // syncUrl is on by default; `filters` is left out.
      return <DataTable caption="Customers" queryKey={['r1']} queryFn={queryFn} columns={columns} rowKey={(r) => r.id} />;
    }
    wrap(<Counting />);
    await waitFor(() => expect(screen.getAllByText('Ahmed Khalid').length).toBeGreaterThan(0));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(queryFn).toHaveBeenCalledTimes(1);
    expect(renders).toBeLessThan(5);
    expect(errors).not.toHaveBeenCalled();
  });

  it('is equally calm when the page passes a new, equal filters array on every render', async () => {
    const queryFn = vi.fn(async (_params: Record<string, unknown>) => page(rows, 55, 2));
    function Parent() {
      const [, tick] = React.useReducer((n: number) => n + 1, 0);
      return (
        <>
          <button onClick={tick}>re-render</button>
          <DataTable caption="Customers" queryKey={['r2']} queryFn={queryFn} columns={columns} rowKey={(r) => r.id} filters={[{ id: 'type', type: 'select', label: 'Type', options: [{ value: 'B', label: 'Business' }] }]} />
        </>
      );
    }
    window.history.replaceState(null, '', '/?type=B&page=2');
    wrap(<Parent />);
    await waitFor(() => expect(queryFn).toHaveBeenCalledTimes(1));
    expect(queryFn.mock.calls[0][0]).toMatchObject({ type: 'B', page: 2 });
    fireEvent.click(screen.getByText('re-render'));
    fireEvent.click(screen.getByText('re-render'));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    // Still on page 2 with the same filter: the URL was not re-read into fresh state.
    expect(queryFn).toHaveBeenCalledTimes(1);
    expect(window.location.search).toBe('?type=B&page=2');
    expect(errors).not.toHaveBeenCalled();
  });

  it('onRowClick: the row reacts, its own controls do not trigger it, and the title is a button for the keyboard', async () => {
    const onRowClick = vi.fn();
    const onSelect = vi.fn();
    wrap(
      <DataTable
        caption="Customers"
        queryKey={['r3']}
        queryFn={async () => page(rows)}
        columns={[...columns, { id: 'link', header: 'Link', cell: () => <a href="#x">Open</a> }]}
        rowKey={(r) => r.id}
        syncUrl={false}
        onRowClick={onRowClick}
        rowActions={[{ id: 'a', label: 'Archive', onSelect }]}
      />,
    );
    await waitFor(() => expect(screen.getAllByText('Sara Mohammed').length).toBeGreaterThan(0));
    const table = screen.getByRole('table');
    const row = Array.from(table.querySelectorAll('tbody tr')).find((tr) => tr.textContent?.includes('Sara Mohammed')) as HTMLElement;
    fireEvent.click(row.querySelectorAll('td')[1]);
    expect(onRowClick).toHaveBeenCalledTimes(1);
    expect(onRowClick).toHaveBeenLastCalledWith(rows[1]);
    // a link and the row menu inside the row belong to themselves
    fireEvent.click(row.querySelector('a') as HTMLElement);
    fireEvent.click(row.querySelector('button[aria-label="More actions"]') as HTMLElement);
    expect(onRowClick).toHaveBeenCalledTimes(1);
    // keyboard: the title cell is a real button
    const title = row.querySelector('td button') as HTMLButtonElement;
    expect(title.textContent).toBe('Sara Mohammed');
    fireEvent.click(title);
    expect(onRowClick).toHaveBeenCalledTimes(2);
  });

  it('starts from initialFilterValues, reports the filters, and follows controlled filterValues', async () => {
    const queryFn = vi.fn(async (_params: Record<string, unknown>) => page(rows, 55));
    const seen: Array<Record<string, string>> = [];
    function Parent() {
      const [values, setValues] = React.useState<Record<string, string>>({ status: 'UNPAID' });
      return (
        <>
          <button onClick={() => setValues({ status: 'PAID' })}>paid</button>
          <output data-testid="values">{JSON.stringify(values)}</output>
          <DataTable
            caption="Invoices"
            queryKey={['r4']}
            queryFn={queryFn}
            columns={columns}
            rowKey={(r) => r.id}
            syncUrl={false}
            // a new object with the same content on every render must not matter
            filterValues={{ ...values }}
            onFilterValuesChange={(next) => {
              seen.push(next);
              setValues(next);
            }}
            filters={[{ id: 'type', type: 'select', label: 'Type', options: [{ value: 'B', label: 'Business' }] }]}
          />
        </>
      );
    }
    wrap(<Parent />);
    await waitFor(() => expect(queryFn).toHaveBeenCalled());
    // the page's value is used from the first request on, although the filter bar has no control for "status"
    expect(queryFn.mock.calls.every((call) => call[0].status === 'UNPAID')).toBe(true);
    // ... and is not echoed back to the page
    expect(seen).toEqual([]);

    fireEvent.click(screen.getByText('paid'));
    await waitFor(() => expect(queryFn.mock.calls.at(-1)?.[0]).toMatchObject({ status: 'PAID', page: 1 }));
    expect(seen).toEqual([]);

    // "Clear filters" in the table is reported to the page
    fireEvent.click(await screen.findByRole('button', { name: 'Clear filters' }));
    await waitFor(() => expect(seen.at(-1)).toEqual({}));
    await waitFor(() => expect(screen.getByTestId('values').textContent).toBe('{}'));
    await waitFor(() => expect(queryFn.mock.calls.at(-1)?.[0].status).toBeUndefined());
    expect(errors).not.toHaveBeenCalled();
  });

  it('initialFilterValues fill what the URL leaves open, and the URL wins where it says something', async () => {
    const queryFn = vi.fn(async (_params: Record<string, unknown>) => page(rows));
    const onFilterValuesChange = vi.fn();
    window.history.replaceState(null, '', '/?status=PAID');
    wrap(<DataTable caption="Invoices" queryKey={['r5']} queryFn={queryFn} columns={columns} rowKey={(r) => r.id} initialFilterValues={{ status: 'UNPAID', branchId: 'b1' }} onFilterValuesChange={onFilterValuesChange} />);
    await waitFor(() => expect(queryFn).toHaveBeenCalledTimes(1));
    expect(queryFn.mock.calls[0][0]).toMatchObject({ status: 'PAID', branchId: 'b1' });
    expect(onFilterValuesChange).toHaveBeenCalledTimes(1);
    expect(onFilterValuesChange).toHaveBeenCalledWith({ status: 'PAID', branchId: 'b1' });
    await waitFor(() => expect(window.location.search).toBe('?status=PAID&branchId=b1'));
  });

  it('onPageLoaded reports the rows, the paging figures and the parameters of each answer', async () => {
    const infos: Array<DataTablePageInfo<Row>> = [];
    wrap(<DataTable caption="Customers" queryKey={['r6']} queryFn={async () => page(rows, 41)} columns={columns} rowKey={(r) => r.id} syncUrl={false} fixedParams={{ branchId: 'b1' }} onPageLoaded={(info) => infos.push(info)} />);
    await waitFor(() => expect(infos.length).toBe(1));
    expect(infos[0]).toMatchObject({ rows, page: 1, pageSize: 20, total: 41, totalPages: 3, params: { branchId: 'b1', page: 1, pageSize: 20 } });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('describeError: the API\'s own sentence before a general one', () => {
  const i18nFor = (dictionaries: Dictionaries, locale: 'en' | 'ar') => ({ t: (key: string) => translate(dictionaries, locale, key), has: (key: string) => hasKey(dictionaries, locale, key) });
  const en = i18nFor(uiDictionaries, 'en');
  const ar = i18nFor(uiDictionaries, 'ar');

  it('shows the specific message for codes the API uses for many situations', () => {
    const plan = 'Your plan includes 3 staff users. Upgrade your subscription to add more.';
    expect(describeError(new ApiError({ status: 402, code: 'PLAN_LIMIT_REACHED', message: plan }), en)).toBe(plan);
    expect(describeError(new ApiError({ status: 402, code: 'PLAN_LIMIT_REACHED', message: plan }), ar)).toBe(plan);
    const forbidden = 'Only a team member who manages tasks can cancel a task.';
    expect(describeError(new ApiError({ status: 403, code: 'FORBIDDEN', message: forbidden }), en)).toBe(forbidden);
    const conflict = 'This branch still has open requests. Move or close them first.';
    expect(describeError(new ApiError({ status: 409, code: 'CONFLICT', message: conflict }), en)).toBe(conflict);
    expect(describeError(new ApiError({ status: 409, code: 'BRANCH_HAS_OPEN_REQUESTS', message: conflict }), ar)).toBe(conflict);
    expect(describeError(new ApiError({ status: 404, code: 'NOT_FOUND', message: 'Request was not found.' }), en)).toBe('Request was not found.');
  });

  it('uses the translated general sentence only when the API had nothing specific to say', async () => {
    // the API's own general sentence
    expect(describeError(new ApiError({ status: 403, code: 'FORBIDDEN', message: 'You do not have permission to do this.' }), ar)).toBe(translate(uiDictionaries, 'ar', 'apiErrorFallbacks.FORBIDDEN'));
    // no usable body: the client had to make the sentence up
    const noBody = await errorFromResponse(new Response('', { status: 409 }));
    expect(noBody.hasServerMessage).toBe(false);
    expect(describeError(noBody, ar)).toBe(translate(uiDictionaries, 'ar', 'apiErrorFallbacks.CONFLICT'));
    const withBody = await errorFromResponse(new Response(JSON.stringify({ statusCode: 402, code: 'PLAN_LIMIT_REACHED', message: 'Your plan includes 1 branch.' }), { status: 402 }));
    expect(withBody.hasServerMessage).toBe(true);
    expect(describeError(withBody, ar)).toBe('Your plan includes 1 branch.');
    // no connection
    expect(describeError(new ApiError({ status: 0, code: 'NETWORK_ERROR', message: 'offline', hasServerMessage: false }), en)).toBe(translate(uiDictionaries, 'en', 'apiErrors.NETWORK_ERROR'));
    // a code nobody knows, without a sentence
    expect(describeError(new ApiError({ status: 418, code: 'TEAPOT', message: '', hasServerMessage: false }), en)).toBe(translate(uiDictionaries, 'en', 'errors.generic'));
    expect(describeError(new ApiError({ status: 403, code: 'SOMETHING_NEW', message: 'x', hasServerMessage: false }), ar)).toBe(translate(uiDictionaries, 'ar', 'errors.forbidden'));
  });

  it('keeps translated wording for codes that have one meaning', () => {
    expect(describeError(new ApiError({ status: 401, code: 'INVALID_CREDENTIALS', message: 'The email or password is incorrect.' }), ar)).toBe(translate(uiDictionaries, 'ar', 'apiErrors.INVALID_CREDENTIALS'));
  });

  it('lets an app or a section add its own codes through its dictionary', () => {
    const app = mergeDictionaries(uiDictionaries, {
      en: { apiErrors: { SLOT_TAKEN: 'That time was just booked by someone else. Choose another.' }, apiErrorFallbacks: { QUEUE_CLOSED: 'The queue is closed.' } },
      ar: { apiErrors: { SLOT_TAKEN: 'حُجز هذا الموعد للتو. اختر موعدًا آخر.' }, apiErrorFallbacks: { QUEUE_CLOSED: 'قائمة الانتظار مغلقة.' } },
    });
    expect(describeError(new ApiError({ status: 409, code: 'SLOT_TAKEN', message: 'Slot taken.' }), i18nFor(app, 'ar'))).toBe('حُجز هذا الموعد للتو. اختر موعدًا آخر.');
    expect(describeError(new ApiError({ status: 409, code: 'QUEUE_CLOSED', message: 'x', hasServerMessage: false }), i18nFor(app, 'ar'))).toBe('قائمة الانتظار مغلقة.');
    // the shared entries are still there
    expect(hasKey(app, 'ar', 'apiErrors.INVALID_CREDENTIALS')).toBe(true);
  });

  it('shows the message of an error thrown on purpose, never that of an engine error', () => {
    expect(describeError(new Error('Choose a branch first.'), en)).toBe('Choose a branch first.');
    expect(describeError('Choose a branch first.', en)).toBe('Choose a branch first.');
    const generic = translate(uiDictionaries, 'en', 'errors.generic');
    expect(describeError(new TypeError("Cannot read properties of undefined (reading 'id')"), en)).toBe(generic);
    expect(describeError(new RangeError('Invalid time value'), en)).toBe(generic);
    expect(describeError(new Error(''), en)).toBe(generic);
    expect(describeError(undefined, en)).toBe(generic);
    expect(describeError({ nothing: true }, en)).toBe(generic);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('FormField: a message caused by a blur waits for the end of the click', () => {
  const schema = z.object({ fullName: z.string().trim().min(2) });
  function Harness() {
    const form = useZodForm(schema, { defaultValues: { fullName: '' } });
    return (
      <Form form={form} onSubmit={() => undefined}>
        <FormField name="fullName" label="Full name" required>
          {(field) => <Input {...field} />}
        </FormField>
        <button type="button">Other control</button>
      </Form>
    );
  }
  const settle = () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

  it('holds the message while the pointer is down, shows it right after the release', async () => {
    wrap(<Harness />);
    const input = screen.getByLabelText(/Full name/) as HTMLInputElement;
    const other = screen.getByText('Other control');
    input.focus();

    // press on another control: the browser blurs the field first
    fireEvent.pointerDown(other);
    fireEvent.blur(input);
    await settle();
    // the field is already marked, but nothing has been added to the layout
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(screen.queryByRole('alert')).toBeNull();

    fireEvent.pointerUp(other);
    fireEvent.click(other);
    const message = await screen.findByRole('alert');
    expect(message.textContent).toBe('This field is required');
    expect(input.getAttribute('aria-describedby')).toBe(message.id);
  });

  it('does not delay anything for the keyboard', async () => {
    wrap(<Harness />);
    const input = screen.getByLabelText(/Full name/) as HTMLInputElement;
    input.focus();
    fireEvent.blur(input); // Tab
    expect((await screen.findByRole('alert')).textContent).toBe('This field is required');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('status kinds the sections needed', () => {
  it('words them in both languages with a tone', () => {
    expect(statusMeta('queue', 'SERVING')).toEqual({ en: 'Being served', ar: 'قيد الخدمة', tone: 'warning' });
    expect(statusMeta('reminderDispatch', 'SKIPPED_NO_CONSENT').tone).toBe('warning');
    expect(statusMeta('notification', 'DELIVERED').tone).toBe('success');
    expect(statusMeta('automationExecution', 'DEAD_LETTER')).toMatchObject({ en: 'Gave up', tone: 'danger' });
    expect(statusMeta('publish', 'PUBLISHED')).toMatchObject({ en: 'Published', ar: 'منشور', tone: 'success' });
  });
});
