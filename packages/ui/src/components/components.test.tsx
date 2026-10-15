import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { z } from 'zod';
import { ApiError } from '@typease/api-client';
import type { Page } from '@typease/types';
import { I18nProvider, uiDictionaries } from '../i18n';
import { ThemeProvider } from '../providers/theme';
import { Button } from './button';
import { StatusBadge } from './badge';
import { ConfirmDialog } from './confirm-dialog';
import { MoneyInput, PhoneInput, SearchInput } from './fields';
import { FileUpload, matchesAccept } from './file-upload';
import { Form, FormError, FormField, normaliseEmpty, useZodForm } from './form';
import { Input } from './input';
import { Pagination } from './pagination';
import { QrCode } from './qr-code';
import { DataTable } from '../data-table/data-table';
import { filterNav, findNavItem, isActivePath, type NavGroup } from '../shell/nav';
import { describeError, safeNextPath } from '../lib/errors';
import { clearTenantCache, isSharedHost, isTenantSlug, resolveTenant } from '../lib/tenant';
import { initialsOf } from './avatar';
import { describeUserAgent } from '../auth/sessions';

function wrap(ui: React.ReactElement, locale: 'en' | 'ar' = 'en') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <I18nProvider locale={locale} dictionaries={uiDictionaries}>
      <ThemeProvider>
        <QueryClientProvider client={client}>{ui}</QueryClientProvider>
      </ThemeProvider>
    </I18nProvider>,
  );
}

describe('Button', () => {
  it('is a real button, defaults to type="button" and blocks clicks while loading', () => {
    const onClick = vi.fn();
    wrap(
      <Button loading loadingText="Saving…" onClick={onClick}>
        Save
      </Button>,
    );
    const button = screen.getByRole('button');
    expect(button).toHaveProperty('type', 'button');
    expect(button).toHaveProperty('disabled', true);
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(screen.getByRole('status').textContent).toBe('Saving…');
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });
});

describe('StatusBadge', () => {
  it('shows the status in words, in the active language', () => {
    const { unmount } = wrap(<StatusBadge kind="request" status="AWAITING_PAYMENT" />);
    expect(screen.getByText('Awaiting payment')).toBeTruthy();
    unmount();
    wrap(<StatusBadge kind="request" status="AWAITING_PAYMENT" />, 'ar');
    expect(screen.getByText('بانتظار الدفع')).toBeTruthy();
  });
  it('prefers the label the API worded for this viewer', () => {
    wrap(<StatusBadge kind="request" status="AWAITING_CUSTOMER" label={{ en: 'Action needed from you', ar: 'مطلوب إجراء منك' }} />);
    expect(screen.getByText('Action needed from you')).toBeTruthy();
  });
});

describe('inputs', () => {
  it('MoneyInput keeps a decimal string and pads on blur', () => {
    const Harness = () => {
      const [v, setV] = React.useState('');
      return (
        <>
          <MoneyInput aria-label="Amount" value={v} onChange={setV} />
          <output>{v}</output>
        </>
      );
    };
    wrap(<Harness />);
    const input = screen.getByLabelText('Amount') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '1,250.5x' } });
    expect(screen.getByRole('status').textContent).toBe('1250.5');
    fireEvent.blur(input);
    expect(screen.getByRole('status').textContent).toBe('1250.50');
    expect(input.getAttribute('inputmode')).toBe('decimal');
  });
  it('PhoneInput produces E.164 with the default +971 and adopts a pasted country code', () => {
    const onChange = vi.fn();
    const Harness = () => {
      const [v, setV] = React.useState('');
      return (
        <PhoneInput
          aria-label="Mobile"
          value={v}
          onChange={(next) => {
            setV(next);
            onChange(next);
          }}
        />
      );
    };
    wrap(<Harness />);
    const input = screen.getByLabelText('Mobile') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '050 123 4567' } });
    expect(onChange).toHaveBeenLastCalledWith('+971501234567');
    fireEvent.change(input, { target: { value: '+44 7911 123456' } });
    expect(onChange).toHaveBeenLastCalledWith('+447911123456');
    expect((screen.getByLabelText('Country code') as HTMLSelectElement).value).toBe('44');
    expect(input.value).toBe('7911123456');
    fireEvent.change(input, { target: { value: '' } });
    expect(onChange).toHaveBeenLastCalledWith('');
  });
  it('SearchInput reports after a pause, and at once on Enter', () => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    wrap(<SearchInput value="" onChange={onChange} debounceMs={300} aria-label="Search" />);
    const input = screen.getByRole('searchbox');
    fireEvent.change(input, { target: { value: 'ah' } });
    fireEvent.change(input, { target: { value: 'ahmed' } });
    expect(onChange).not.toHaveBeenCalled();
    act(() => void vi.advanceTimersByTime(300));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith('ahmed');
    fireEvent.change(input, { target: { value: 'ahmed k' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenLastCalledWith('ahmed k');
    vi.useRealTimers();
  });
});

describe('Form', () => {
  const schema = z.object({ fullName: z.string().trim().min(2), email: z.string().email() });
  function Harness({ onSubmit }: { onSubmit: (v: z.infer<typeof schema>) => Promise<void> }) {
    const form = useZodForm(schema, { defaultValues: { fullName: '', email: '' } });
    return (
      <Form form={form} onSubmit={onSubmit}>
        <FormField name="fullName" label="Full name" required hint="As in the passport">
          {(field) => <Input {...field} />}
        </FormField>
        <FormField name="email" label="Email" required>
          {(field) => <Input {...field} />}
        </FormField>
        <FormError />
        <button type="submit">Save</button>
      </Form>
    );
  }
  it('shows inline errors linked to their fields, in the UI language', async () => {
    const onSubmit = vi.fn();
    wrap(<Harness onSubmit={onSubmit} />, 'ar');
    fireEvent.click(screen.getByText('Save'));
    const name = (await screen.findByLabelText(/Full name/)) as HTMLInputElement;
    await waitFor(() => expect(name.getAttribute('aria-invalid')).toBe('true'));
    const error = document.getElementById(name.getAttribute('aria-describedby') as string);
    expect(error?.getAttribute('role')).toBe('alert');
    // An emptied field reaches the schema as "absent", so the message is "required", not "at least 2 characters".
    expect(error?.textContent).toBe('هذا الحقل مطلوب');
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.change(name, { target: { value: 'A' } });
    await waitFor(() => expect(document.getElementById(name.getAttribute('aria-describedby') as string)?.textContent).toBe('استخدم 2 أحرف على الأقل'));
  });
  it('maps API field errors onto fields, keeps the input, and shows other errors on the form', async () => {
    const onSubmit = vi
      .fn()
      .mockRejectedValueOnce(new ApiError({ status: 400, code: 'VALIDATION_FAILED', message: 'Please check the highlighted fields.', details: [{ path: 'email', message: 'Enter a valid email address' }, { path: 'tagIds', message: 'Too many' }] }))
      .mockRejectedValueOnce(new ApiError({ status: 402, code: 'PLAN_LIMIT_REACHED', message: 'Your plan includes 3 staff users. Upgrade your subscription to add more.' }))
      .mockResolvedValueOnce(undefined);
    wrap(<Harness onSubmit={onSubmit} />);
    fireEvent.change(screen.getByLabelText(/Full name/), { target: { value: 'Aisha Khan' } });
    fireEvent.change(screen.getByLabelText(/Email/), { target: { value: 'aisha@example.ae' } });
    fireEvent.click(screen.getByText('Save'));
    const email = screen.getByLabelText(/Email/) as HTMLInputElement;
    await waitFor(() => expect(email.getAttribute('aria-invalid')).toBe('true'));
    expect(document.getElementById(email.getAttribute('aria-describedby') as string)?.textContent).toBe('Enter a valid email address, such as name@example.com');
    // A field error for something this form does not show ends up in the form-level message.
    expect(screen.getByText('tagIds: Too many')).toBeTruthy();
    expect((screen.getByLabelText(/Full name/) as HTMLInputElement).value).toBe('Aisha Khan');
    expect(email.value).toBe('aisha@example.ae');

    fireEvent.click(screen.getByText('Save'));
    // The API's sentence names the limit; the general wording for the code would hide that.
    await screen.findByText('Your plan includes 3 staff users. Upgrade your subscription to add more.');
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(screen.queryByText(/Your plan includes/)).toBeNull());
  });
});

describe('normaliseEmpty', () => {
  it('turns emptied fields into undefined or null at any depth', () => {
    const values = { fullName: 'A', email: '', address: { city: '', line1: 'Villa 12' }, tags: ['', 'x'], n: 0, flag: false };
    expect(normaliseEmpty(values, 'undefined')).toEqual({ fullName: 'A', email: undefined, address: { city: undefined, line1: 'Villa 12' }, tags: [undefined, 'x'], n: 0, flag: false });
    expect(normaliseEmpty(values, 'null').email).toBeNull();
    expect(normaliseEmpty(values, 'keep')).toBe(values);
  });
});

describe('ConfirmDialog', () => {
  it('unlocks the destructive action only after the confirmation text is typed', async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    const onOpenChange = vi.fn();
    wrap(<ConfirmDialog open onOpenChange={onOpenChange} title="Merge customers" description="This cannot be undone." confirmLabel="Merge" typedConfirmation="CUS-000017" onConfirm={onConfirm} />);
    const confirm = screen.getByRole('button', { name: 'Merge' }) as HTMLButtonElement;
    expect(screen.getByRole('alertdialog')).toBeTruthy();
    expect(confirm.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Type CUS-000017 to confirm'), { target: { value: 'cus-000017' } });
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });
});

describe('FileUpload', () => {
  it('matches MIME types, wildcards and extensions', () => {
    expect(matchesAccept({ name: 'a.PDF', type: 'application/pdf' }, ['application/pdf'])).toBe(true);
    expect(matchesAccept({ name: 'a.jpg', type: 'image/jpeg' }, ['image/*'])).toBe(true);
    expect(matchesAccept({ name: 'a.docx', type: '' }, ['.docx'])).toBe(true);
    expect(matchesAccept({ name: 'a.exe', type: 'application/x-msdownload' }, ['application/pdf', 'image/*'])).toBe(false);
    expect(matchesAccept({ name: 'a.exe', type: '' }, [])).toBe(true);
  });
  it('rejects wrong types and oversize files by name, uploads the rest with progress', async () => {
    let finish: (v: string) => void = () => undefined;
    const upload = vi.fn((_file: File, o: { onProgress: (f: number) => void }) => {
      o.onProgress(0.4);
      return new Promise<string>((resolve) => (finish = resolve));
    });
    const onUploaded = vi.fn();
    const { container } = wrap(<FileUpload upload={upload} onUploaded={onUploaded} accept={['application/pdf', 'image/*']} maxSizeBytes={1000} capture="environment" />);
    const input = container.querySelector('input[type="file"]:not([capture])') as HTMLInputElement;
    const good = new File(['%PDF'], 'Passport.pdf', { type: 'application/pdf' });
    const bad = new File(['MZ'], 'setup.exe', { type: 'application/x-msdownload' });
    const big = new File([new Uint8Array(2000)], 'scan.png', { type: 'image/png' });
    fireEvent.change(input, { target: { files: [good, bad, big] } });
    expect(await screen.findByText('“setup.exe” is not an accepted file type.')).toBeTruthy();
    expect(screen.getByText(/“scan.png” is larger than/)).toBeTruthy();
    expect(upload).toHaveBeenCalledTimes(1);
    const bar = await screen.findByRole('progressbar');
    await waitFor(() => expect(bar.getAttribute('aria-valuenow')).toBe('40'));
    await act(async () => finish('doc-1'));
    await screen.findByText('Uploaded');
    expect(onUploaded).toHaveBeenCalledWith(expect.objectContaining({ status: 'done', result: 'doc-1' }));
    // The camera input asks the phone for the rear camera.
    expect(container.querySelector('input[capture="environment"]')?.getAttribute('accept')).toBe('image/*');
    fireEvent.click(screen.getByRole('button', { name: 'Remove Passport.pdf' }));
    expect(screen.queryByText('Passport.pdf')).toBeNull();
  });
});

describe('Pagination', () => {
  it('summarises the range and disables the ends', () => {
    const onPageChange = vi.fn();
    wrap(<Pagination meta={{ page: 1, pageSize: 20, total: 135, totalPages: 7 }} onPageChange={onPageChange} />);
    expect(screen.getByText('Showing 1–20 of 135')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Previous page' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    expect(onPageChange).toHaveBeenCalledWith(2);
    fireEvent.click(screen.getByRole('button', { name: 'Last page' }));
    expect(onPageChange).toHaveBeenCalledWith(7);
  });
});

describe('DataTable', () => {
  interface Row {
    id: string;
    name: string;
  }
  const page = (rows: Row[], total = rows.length): Page<Row> => ({ data: rows, meta: { page: 1, pageSize: 20, total, totalPages: Math.max(1, Math.ceil(total / 20)) } });
  const columns = [{ id: 'name', header: 'Name', cell: (r: Row) => r.name, sortField: 'fullName', mobile: 'title' as const }];

  it('asks the server for sorted, filtered pages and shows the rows', async () => {
    const queryFn = vi.fn(async (_params: Record<string, unknown>) => page([{ id: '1', name: 'Ahmed Khalid' }], 1));
    wrap(<DataTable caption="Customers" queryKey={['t1']} queryFn={queryFn} columns={columns} rowKey={(r) => r.id} defaultSort="createdAt:desc" syncUrl={false} filters={[{ id: 'type', type: 'select', label: 'Type', options: [{ value: 'BUSINESS', label: 'Business' }] }]} />);
    expect(screen.getByText('Loading rows')).toBeTruthy();
    await waitFor(() => expect(screen.getAllByText('Ahmed Khalid').length).toBeGreaterThan(0));
    expect(queryFn.mock.calls[0][0]).toEqual({ page: 1, pageSize: 20, sort: 'createdAt:desc', q: undefined });
    fireEvent.click(screen.getByRole('button', { name: /Name/ }));
    await waitFor(() => expect(queryFn).toHaveBeenCalledTimes(2));
    expect(queryFn.mock.calls[1][0]).toMatchObject({ sort: 'fullName:asc', page: 1 });
    await waitFor(() => expect(screen.getByRole('columnheader', { name: /Name/ }).getAttribute('aria-sort')).toBe('ascending'));
  });
  it('explains an empty list and offers the action', async () => {
    wrap(<DataTable caption="Customers" queryKey={['t2']} queryFn={async () => page([])} columns={columns} rowKey={(r) => r.id} syncUrl={false} empty={{ title: 'No customers yet', description: 'Add the first one.', action: <button>Add customer</button> }} />);
    expect((await screen.findAllByText('No customers yet')).length).toBeGreaterThan(0);
    expect(screen.getAllByText('Add customer').length).toBeGreaterThan(0);
  });
  it('shows a retry when loading fails, then recovers', async () => {
    const queryFn = vi
      .fn<() => Promise<Page<Row>>>()
      .mockRejectedValueOnce(new ApiError({ status: 0, code: 'NETWORK_ERROR', message: 'offline' }))
      .mockResolvedValue(page([{ id: '1', name: 'Sara Mohammed' }]));
    wrap(<DataTable caption="Customers" queryKey={['t3']} queryFn={queryFn} columns={columns} rowKey={(r) => r.id} syncUrl={false} />);
    expect(await screen.findByText('This list could not be loaded')).toBeTruthy();
    expect(screen.getByText('Could not reach the server. Check your internet connection and try again.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.getAllByText('Sara Mohammed').length).toBeGreaterThan(0));
  });
});

describe('QrCode', () => {
  it('renders an accessible black-on-white SVG', () => {
    const { container } = render(<QrCode value="otpauth://totp/TypEase:a%40b.ae?secret=JBSWY3DPEHPK3PXP&issuer=TypEase" label="QR code for the authenticator app" />);
    const svg = container.querySelector('svg') as SVGSVGElement;
    expect(svg.getAttribute('role')).toBe('img');
    expect(svg.getAttribute('aria-label')).toBe('QR code for the authenticator app');
    expect(svg.querySelector('rect')?.getAttribute('fill')).toBe('#fff');
    expect(svg.querySelector('path')?.getAttribute('d')?.length).toBeGreaterThan(500);
  });
});

describe('navigation model', () => {
  const Icon = (() => null) as never;
  const nav: NavGroup[] = [
    { id: 'main', items: [{ id: 'dashboard', labelKey: 'nav.dashboard', icon: Icon, href: '/dashboard' }, { id: 'requests', labelKey: 'nav.requests', icon: Icon, href: '/requests', anyOf: ['request.read.all', 'request.read.assigned'] }] },
    { id: 'finance', labelKey: 'nav.finance', items: [{ id: 'refunds', labelKey: 'nav.refunds', icon: Icon, href: '/refunds', anyOf: ['refund.request', 'refund.approve'] }] },
    { id: 'admin', labelKey: 'nav.admin', items: [{ id: 'settings', labelKey: 'nav.settings', icon: Icon, href: '/settings', allOf: ['settings.manage'] }, { id: 'security', labelKey: 'nav.security', icon: Icon, href: '/settings/security' }] },
  ];
  const session = (permissions: string[]) => ({ hasPermission: (p: string) => permissions.includes(p), hasAnyPermission: (list: readonly string[]) => list.length === 0 || list.some((p) => permissions.includes(p)) });
  it('filters items by permission and drops empty groups', () => {
    const visible = filterNav(nav, session(['request.read.assigned']));
    expect(visible.map((g) => g.id)).toEqual(['main', 'admin']);
    expect(visible[0].items.map((i) => i.id)).toEqual(['dashboard', 'requests']);
    expect(visible[1].items.map((i) => i.id)).toEqual(['security']);
    expect(filterNav(nav, session(['refund.approve', 'settings.manage'])).map((g) => g.id)).toEqual(['main', 'finance', 'admin']);
  });
  it('marks the right item as active', () => {
    expect(isActivePath('/requests', { href: '/requests' })).toBe(true);
    expect(isActivePath('/requests/123/documents', { href: '/requests' })).toBe(true);
    expect(isActivePath('/requests-archive', { href: '/requests' })).toBe(false);
    expect(isActivePath('/dashboard', { href: '/' })).toBe(false);
    expect(isActivePath('/settings/security', { href: '/settings', exact: true })).toBe(false);
    expect(findNavItem(nav, '/settings/security')?.id).toBe('security');
  });
});

describe('helpers', () => {
  it('only follows same-site paths after sign-in', () => {
    expect(safeNextPath('/requests?bucket=overdue', '/dashboard')).toBe('/requests?bucket=overdue');
    for (const bad of ['https://evil.example', '//evil.example', '/\\evil.example', 'javascript:alert(1)', '', null, undefined]) expect(safeNextPath(bad, '/dashboard')).toBe('/dashboard');
  });
  it('words API errors: own wording for known codes, the API message otherwise', () => {
    const i18n = { t: (k: string) => `T(${k})`, has: (k: string) => k === 'apiErrors.INVALID_CREDENTIALS' };
    expect(describeError(new ApiError({ status: 401, code: 'INVALID_CREDENTIALS', message: 'x' }), i18n)).toBe('T(apiErrors.INVALID_CREDENTIALS)');
    expect(describeError(new ApiError({ status: 422, code: 'ASSIGNEE_NOT_AT_BRANCH', message: 'The assignee does not work at this branch.' }), i18n)).toBe('The assignee does not work at this branch.');
    // a plain Error thrown on purpose carries its own sentence; an engine error never does (see regressions.test.tsx)
    expect(describeError(new Error('boom'), i18n)).toBe('boom');
    expect(describeError(new TypeError('boom'), i18n)).toBe('T(errors.generic)');
  });
  it('makes initials and device names', () => {
    expect(initialsOf('Noor Al Mansoori')).toBe('NM');
    expect(initialsOf('أحمد خالد')).toBe('أخ');
    expect(initialsOf('Sara Ali (HR)')).toBe('SA');
    expect(initialsOf('')).toBe('?');
    expect(describeUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36')).toEqual({ name: 'Chrome, Windows', mobile: false });
    expect(describeUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Version/17.5 Mobile/15E148 Safari/604.1')).toEqual({ name: 'Safari, iOS', mobile: true });
    expect(describeUserAgent('curl/8.5.0')).toBeNull();
  });
});

describe('tenant resolution', () => {
  const config = (slug: string) => ({ slug, name: slug, mode: 'WHITE_LABEL' });
  const api = (known: Record<string, string>) =>
    vi.fn(async (url: string | URL | Request) => {
      const u = new URL(String(url));
      const key = u.searchParams.get('host') ? `host:${u.searchParams.get('host')}` : `slug:${u.searchParams.get('slug')}`;
      return known[key] ? new Response(JSON.stringify(config(known[key])), { status: 200 }) : new Response('{}', { status: 404 });
    }) as unknown as typeof fetch;

  it('prefers the host, then ?tenant=, then the cookie, then the default', async () => {
    clearTenantCache();
    const fetchMock = api({ 'host:portal.alnoor.ae': 'alnoor', 'slug:gulf': 'gulf', 'slug:demo': 'demo' });
    const base = { apiUrl: 'http://api.test', fetch: fetchMock };
    expect(await resolveTenant({ ...base, host: 'portal.alnoor.ae', requestedSlug: 'gulf' })).toMatchObject({ via: 'host', config: { slug: 'alnoor' } });
    expect(await resolveTenant({ ...base, host: 'localhost:3002', requestedSlug: 'gulf', cookieSlug: 'demo' })).toMatchObject({ via: 'query', config: { slug: 'gulf' } });
    expect(await resolveTenant({ ...base, host: 'localhost:3002', cookieSlug: 'demo' })).toMatchObject({ via: 'cookie', config: { slug: 'demo' } });
    expect(await resolveTenant({ ...base, host: 'unknown.example', cookieSlug: 'nope', defaultSlug: 'demo' })).toMatchObject({ via: 'default', config: { slug: 'demo' } });
    expect(await resolveTenant({ ...base, host: 'localhost:3002', requestedSlug: 'missing-centre' })).toEqual({ config: null, via: 'none' });
  });
  it('validates slugs, skips shared hosts and caches lookups', async () => {
    clearTenantCache();
    const fetchMock = api({ 'slug:gulf': 'gulf' });
    const base = { apiUrl: 'http://api.test/api/v1', fetch: fetchMock, host: 'localhost' };
    await resolveTenant({ ...base, requestedSlug: 'gulf' });
    await resolveTenant({ ...base, requestedSlug: 'gulf' });
    await resolveTenant({ ...base, requestedSlug: '../etc/passwd' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String((fetchMock as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0])).toBe('http://api.test/api/v1/public/tenant-config?slug=gulf');
    expect(isTenantSlug('al-noor-2')).toBe(true);
    expect(isTenantSlug('Al Noor')).toBe(false);
    expect(isSharedHost('localhost:3002')).toBe(true);
    expect(isSharedHost('portal.typease.ae', ['portal.typease.ae'])).toBe(true);
    expect(isSharedHost('alnoor.typease.ae')).toBe(false);
  });
});
