'use client';

import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Combobox, Select, roleDisplayName, useApi, useI18n, type ComboboxOption, type ComboboxProps } from '@typease/ui';
import type { Page } from '@typease/types';

/**
 * Entity pickers shared by every section of the staff app. All of them are
 * searchable (spec: searchable dropdowns for large lists), work with React
 * Hook Form (`value` / `onValueChange` / `onBlur` / aria props) and hand the
 * picked record back as the second argument so forms can prefill from it.
 */
type PickerBase = Omit<ComboboxProps, 'options' | 'loadOptions' | 'onValueChange' | 'value'> & { value: string | null | undefined };

export interface CustomerOption {
  id: string;
  customerNo: string;
  fullName: string;
  fullNameAr: string | null;
  phone: string | null;
  email: string | null;
  type: string;
  corporateAccountId: string | null;
}

/** Server-side search over customers by name, number, phone or email. */
export function CustomerPicker({ onChange, corporateAccountId, ...props }: PickerBase & { onChange: (id: string, customer: CustomerOption | null) => void; corporateAccountId?: string }) {
  const api = useApi();
  const { t } = useI18n();
  const cache = React.useRef(new Map<string, CustomerOption>());
  const load = React.useCallback(
    async (q: string, signal: AbortSignal): Promise<ComboboxOption[]> => {
      const page = await api.client.get<Page<CustomerOption>>('/customers', { query: { q: q || undefined, pageSize: 20, status: 'ACTIVE', corporateAccountId }, signal });
      for (const c of page.data) cache.current.set(c.id, c);
      return page.data.map((c) => ({ value: c.id, label: c.fullName, description: [c.customerNo, c.phone ?? c.email].filter(Boolean).join(' · ') }));
    },
    [api, corporateAccountId],
  );
  return (
    <Combobox
      placeholder={t('pickers.customer.placeholder')}
      searchPlaceholder={t('pickers.customer.search')}
      emptyText={t('pickers.customer.empty')}
      clearable
      {...props}
      loadOptions={load}
      onValueChange={(id) => onChange(id, cache.current.get(id) ?? null)}
    />
  );
}

export interface ServiceOption {
  id: string;
  code: string;
  name: string;
  nameAr: string | null;
  categoryId: string;
  isActive: boolean;
  complianceCapability: string;
  requiresApproval: boolean;
  paymentPolicy: string;
}

/** The centre's active services (loaded once, filtered while typing). */
export function useServiceOptions(enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: ['services', 'picker'],
    queryFn: async () => (await api.client.get<Page<ServiceOption>>('/services', { query: { pageSize: 100, sort: 'name:asc' } })).data,
    staleTime: 5 * 60_000,
    enabled,
  });
}
export function ServicePicker({ onChange, includeInactive = false, ...props }: PickerBase & { onChange: (id: string, service: ServiceOption | null) => void; includeInactive?: boolean }) {
  const { t, pick } = useI18n();
  const services = useServiceOptions();
  const list = (services.data ?? []).filter((s) => includeInactive || s.isActive);
  return (
    <Combobox
      placeholder={t('pickers.service.placeholder')}
      searchPlaceholder={t('pickers.service.search')}
      emptyText={services.isLoading ? t('common.loading') : t('pickers.service.empty')}
      {...props}
      options={list.map((s) => ({ value: s.id, label: pick(s.name, s.nameAr), description: s.code, keywords: [s.name, s.nameAr ?? '', s.code] }))}
      onValueChange={(id) => onChange(id, list.find((s) => s.id === id) ?? null)}
    />
  );
}

export interface StaffOption {
  id: string;
  userId: string;
  status: string;
  isAvailable: boolean;
  allBranches: boolean;
  branchIds: string[];
  jobTitle: string | null;
  user: { id: string; fullName: string; email: string };
  role: { id: string; key: string; name: string };
}

export function useStaffOptions(enabled = true) {
  const api = useApi();
  return useQuery({ queryKey: ['staff', 'picker'], queryFn: () => api.client.get<StaffOption[]>('/staff', { query: { status: 'ACTIVE' } }), staleTime: 60_000, enabled });
}
/** Active staff members. The value is the MEMBERSHIP id (what assignment endpoints expect). */
export function StaffPicker({ onChange, branchId, roleKeys, ...props }: PickerBase & { onChange: (membershipId: string, member: StaffOption | null) => void; branchId?: string; roleKeys?: string[] }) {
  const { t } = useI18n();
  const staff = useStaffOptions();
  const list = (staff.data ?? []).filter((m) => (!branchId || m.allBranches || m.branchIds.includes(branchId)) && (!roleKeys?.length || roleKeys.includes(m.role.key)));
  return (
    <Combobox
      placeholder={t('pickers.staff.placeholder')}
      searchPlaceholder={t('pickers.staff.search')}
      emptyText={staff.isLoading ? t('common.loading') : t('pickers.staff.empty')}
      clearable
      {...props}
      options={list.map((m) => ({ value: m.id, label: m.user.fullName, description: `${m.role.name}${m.isAvailable ? '' : ` · ${t('pickers.staff.unavailable')}`}`, keywords: [m.user.email] }))}
      onValueChange={(id) => onChange(id, list.find((m) => m.id === id) ?? null)}
    />
  );
}

export interface CorporateAccountOption {
  id: string;
  accountNo: string;
  companyName: string;
  companyNameAr: string | null;
  status: string;
}
export function CorporateAccountPicker({ onChange, ...props }: PickerBase & { onChange: (id: string, account: CorporateAccountOption | null) => void }) {
  const api = useApi();
  const { t } = useI18n();
  const cache = React.useRef(new Map<string, CorporateAccountOption>());
  const load = React.useCallback(
    async (q: string, signal: AbortSignal): Promise<ComboboxOption[]> => {
      const page = await api.client.get<Page<CorporateAccountOption>>('/corporate-accounts', { query: { q: q || undefined, pageSize: 20 }, signal });
      for (const a of page.data) cache.current.set(a.id, a);
      return page.data.map((a) => ({ value: a.id, label: a.companyName, description: a.accountNo }));
    },
    [api],
  );
  return (
    <Combobox
      placeholder={t('pickers.corporate.placeholder')}
      searchPlaceholder={t('pickers.corporate.search')}
      emptyText={t('pickers.corporate.empty')}
      clearable
      {...props}
      loadOptions={load}
      onValueChange={(id) => onChange(id, cache.current.get(id) ?? null)}
    />
  );
}

export interface DocumentTypeOption {
  id: string;
  key: string;
  name: string;
  nameAr: string | null;
  hasExpiry: boolean;
  ocrProfile: string;
  isActive: boolean;
}
export function useDocumentTypes() {
  const api = useApi();
  return useQuery({ queryKey: ['document-types'], queryFn: () => api.client.get<DocumentTypeOption[]>('/document-types'), staleTime: 10 * 60_000 });
}
/** The value is the document type KEY (e.g. "passport"). */
export function DocumentTypePicker({ onChange, ...props }: PickerBase & { onChange: (key: string, type: DocumentTypeOption | null) => void }) {
  const { t, pick } = useI18n();
  const types = useDocumentTypes();
  const list = (types.data ?? []).filter((d) => d.isActive);
  return (
    <Combobox
      placeholder={t('pickers.documentType.placeholder')}
      searchPlaceholder={t('pickers.documentType.search')}
      emptyText={t('pickers.documentType.empty')}
      {...props}
      options={list.map((d) => ({ value: d.key, label: pick(d.name, d.nameAr), keywords: [d.key, d.name, d.nameAr ?? ''] }))}
      onValueChange={(key) => onChange(key, list.find((d) => d.key === key) ?? null)}
    />
  );
}

export interface RoleOption {
  id: string;
  key: string;
  name: string;
  kind: string;
  isSystem: boolean;
  permissions: string[];
}
export function useRoles(enabled = true) {
  const api = useApi();
  return useQuery({ queryKey: ['roles'], queryFn: () => api.client.get<RoleOption[]>('/roles'), staleTime: 60_000, enabled });
}
/** Staff roles of the centre. The value is the role KEY. */
export function RoleSelect({ value, onChange, ...props }: { value: string | undefined; onChange: (key: string) => void; id?: string; disabled?: boolean; placeholder?: string; 'aria-invalid'?: boolean; 'aria-describedby'?: string; onBlur?: () => void }) {
  const roles = useRoles();
  const { locale } = useI18n();
  const list = (roles.data ?? []).filter((r) => r.kind === 'STAFF');
  // Built-in roles have an Arabic name (packages/permissions); roles the centre created keep the name it gave them.
  return <Select {...props} disabled={props.disabled || roles.isLoading} value={value ?? null} onValueChange={onChange} options={list.map((r) => ({ value: r.key, label: roleDisplayName(r, locale) }))} />;
}
