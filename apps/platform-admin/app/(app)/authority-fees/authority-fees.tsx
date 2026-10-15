'use client';

import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Landmark, Plus } from 'lucide-react';
import { AUTHORITIES } from '@typease/validation';
import {
  Alert, Badge, Button, Card, DatePicker, Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, EmptyState, Input, Label, MoneyInput, PageHeader,
  RequirePermission, Select, Switch, Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow, Textarea, useApiClient, useErrorMessage, useI18n, useToast,
} from '@typease/ui';
import { RowsSkeleton } from '@/components/shared';

interface Fee {
  id: string;
  authority: (typeof AUTHORITIES)[number];
  code: string;
  name: string;
  nameAr: string | null;
  category: string | null;
  governmentFee: string;
  thirdPartyFee: string;
  notes: string | null;
  sourceUrl: string | null;
  verifiedAt: string | null;
  isSample: boolean;
  isActive: boolean;
  version: number;
  linkedServices: number;
}
interface Change {
  version: number;
  governmentFeeBefore: string;
  governmentFeeAfter: string;
  thirdPartyFeeBefore: string;
  thirdPartyFeeAfter: string;
  note: string | null;
  createdAt: string;
}
const KEY = ['platform', 'authority-fees'] as const;
const ALL = '__all__';

export function AuthorityFees() {
  return (
    <RequirePermission anyOf={['platform.fees.manage']}>
      <FeesScreen />
    </RequirePermission>
  );
}

function FeesScreen() {
  const { t, tn, pick, formatMoney, formatDate } = useI18n();
  const client = useApiClient();
  const [authority, setAuthority] = React.useState(ALL);
  const [q, setQ] = React.useState('');
  const [editing, setEditing] = React.useState<Fee | 'new' | null>(null);
  const fees = useQuery({ queryKey: [...KEY, authority, q], queryFn: () => client.get<Fee[]>('/platform/authority-fees', { query: { ...(authority !== ALL ? { authority } : {}), ...(q.trim() ? { q: q.trim() } : {}) } }) });
  const samples = (fees.data ?? []).filter((f) => f.isSample && f.isActive).length;
  return (
    <>
      <PageHeader
        title={t('nav.fees')}
        description={t('fees.description')}
        action={
          <Button variant="accent" onClick={() => setEditing('new')}>
            <Plus aria-hidden="true" />
            {t('fees.add')}
          </Button>
        }
      />
      {samples ? <Alert tone="warning" className="mb-4">{tn('fees.samplesWarning', samples)}</Alert> : null}
      <Card className="mb-4 flex flex-wrap items-end gap-3 p-4">
        <div className="space-y-1.5">
          <Label htmlFor="fee-authority">{t('fees.authority')}</Label>
          <Select id="fee-authority" className="w-48" value={authority} onValueChange={setAuthority} options={[{ value: ALL, label: t('fees.allAuthorities') }, ...AUTHORITIES.map((a) => ({ value: a, label: t(`fees.authorities.${a}`) }))]} />
        </div>
        <div className="min-w-56 flex-1 space-y-1.5">
          <Label htmlFor="fee-q">{t('fees.search')}</Label>
          <Input id="fee-q" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('fees.searchHint')} />
        </div>
      </Card>
      {!fees.data ? (
        <RowsSkeleton rows={8} />
      ) : fees.data.length === 0 ? (
        <EmptyState icon={<Landmark />} title={t('fees.empty')} description={t('fees.emptyText')} />
      ) : (
        <Card className="overflow-x-auto">
          <Table>
            <TableCaption className="sr-only">{t('nav.fees')}</TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead>{t('fees.columns.entry')}</TableHead>
                <TableHead>{t('fees.authority')}</TableHead>
                <TableHead className="text-end">{t('fees.columns.government')}</TableHead>
                <TableHead className="text-end">{t('fees.columns.thirdParty')}</TableHead>
                <TableHead>{t('fees.columns.status')}</TableHead>
                <TableHead className="text-end">{t('fees.columns.services')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {fees.data.map((f) => (
                <TableRow key={f.id} className={f.isActive ? 'cursor-pointer' : 'cursor-pointer opacity-60'} onClick={() => setEditing(f)}>
                  <TableCell>
                    <button type="button" className="text-start font-medium hover:underline" onClick={() => setEditing(f)}>
                      {pick(f.name, f.nameAr)}
                    </button>
                    <span className="block text-xs text-muted-foreground tabular">
                      {f.code}
                      {f.category ? ` · ${f.category}` : ''} · v{f.version}
                    </span>
                  </TableCell>
                  <TableCell>
                    <Badge tone="neutral">{t(`fees.authorities.${f.authority}`)}</Badge>
                  </TableCell>
                  <TableCell className="text-end tabular">{formatMoney(f.governmentFee)}</TableCell>
                  <TableCell className="text-end tabular">{formatMoney(f.thirdPartyFee)}</TableCell>
                  <TableCell>
                    {!f.isActive ? (
                      <Badge tone="neutral">{t('fees.inactive')}</Badge>
                    ) : f.isSample ? (
                      <Badge tone="warning" dot>{t('fees.sample')}</Badge>
                    ) : (
                      <Badge tone="success" dot>{f.verifiedAt ? t('fees.verifiedOn', { date: formatDate(f.verifiedAt) }) : t('fees.verified')}</Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-end tabular">{f.linkedServices}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
      {editing ? <FeeDialog fee={editing === 'new' ? null : editing} onClose={() => setEditing(null)} /> : null}
    </>
  );
}

function FeeDialog({ fee, onClose }: { fee: Fee | null; onClose: () => void }) {
  const { t, tn, formatMoney, formatDateTime } = useI18n();
  const client = useApiClient();
  const queryClient = useQueryClient();
  const toasts = useToast();
  const describe = useErrorMessage();
  const [v, setV] = React.useState({
    authority: fee?.authority ?? 'AMER',
    code: fee?.code ?? '',
    name: fee?.name ?? '',
    nameAr: fee?.nameAr ?? '',
    category: fee?.category ?? '',
    governmentFee: fee?.governmentFee ?? '',
    thirdPartyFee: fee?.thirdPartyFee ?? '0',
    notes: fee?.notes ?? '',
    sourceUrl: fee?.sourceUrl ?? '',
    verifiedAt: fee?.verifiedAt ?? '',
    isSample: fee?.isSample ?? false,
    isActive: fee?.isActive ?? true,
    changeNote: '',
  });
  const set = (patch: Partial<typeof v>) => setV((x) => ({ ...x, ...patch }));
  const amountsChanged = !!fee && (Number(v.governmentFee) !== Number(fee.governmentFee) || Number(v.thirdPartyFee) !== Number(fee.thirdPartyFee));
  const history = useQuery({ queryKey: [...KEY, 'history', fee?.id], queryFn: () => client.get<Change[]>(`/platform/authority-fees/${fee!.id}/history`), enabled: !!fee });
  const save = useMutation({
    mutationFn: () => {
      const body = {
        authority: v.authority,
        name: v.name,
        nameAr: v.nameAr || null,
        category: v.category || null,
        governmentFee: v.governmentFee,
        thirdPartyFee: v.thirdPartyFee || '0',
        notes: v.notes || null,
        sourceUrl: v.sourceUrl || null,
        verifiedAt: v.verifiedAt || null,
        isSample: v.isSample,
        isActive: v.isActive,
      };
      return fee ? client.patch(`/platform/authority-fees/${fee.id}`, { ...body, version: fee.version, changeNote: v.changeNote || null }) : client.post('/platform/authority-fees', { ...body, code: v.code });
    },
    onSuccess: () => {
      toasts.success(amountsChanged ? t('fees.savedNewVersion') : t('fees.saved'));
      void queryClient.invalidateQueries({ queryKey: KEY });
      onClose();
    },
  });
  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>{fee ? fee.code : t('fees.add')}</DialogTitle>
          <DialogDescription>{t('fees.dialogText')}</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="f-authority">{t('fees.authority')}</Label>
              <Select id="f-authority" value={v.authority} onValueChange={(x) => set({ authority: x as Fee['authority'] })} options={AUTHORITIES.map((a) => ({ value: a, label: t(`fees.authorities.${a}`) }))} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="f-code">{t('fees.code')}</Label>
              <Input id="f-code" value={v.code} disabled={!!fee} onChange={(e) => set({ code: e.target.value.toUpperCase() })} placeholder="AMER-RES-RENEW" dir="ltr" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="f-category">{t('fees.category')}</Label>
              <Input id="f-category" value={v.category} onChange={(e) => set({ category: e.target.value })} maxLength={60} />
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="f-name">{t('fees.name')}</Label>
              <Input id="f-name" value={v.name} onChange={(e) => set({ name: e.target.value })} maxLength={160} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="f-name-ar">{t('fees.nameAr')}</Label>
              <Input id="f-name-ar" dir="rtl" value={v.nameAr} onChange={(e) => set({ nameAr: e.target.value })} maxLength={160} />
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="f-gov">{t('fees.columns.government')}</Label>
              <MoneyInput id="f-gov" value={v.governmentFee} onChange={(x) => set({ governmentFee: x })} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="f-third">{t('fees.columns.thirdParty')}</Label>
              <MoneyInput id="f-third" value={v.thirdPartyFee} onChange={(x) => set({ thirdPartyFee: x })} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="f-verified">{t('fees.verifiedAt')}</Label>
              <DatePicker id="f-verified" value={v.verifiedAt} onChange={(x) => set({ verifiedAt: x })} />
            </div>
          </div>
          {amountsChanged ? (
            <div className="space-y-1.5 rounded-md border border-warning/40 bg-warning-soft/40 p-3">
              <Label htmlFor="f-change">{t('fees.changeNote')}</Label>
              <Input id="f-change" value={v.changeNote} onChange={(e) => set({ changeNote: e.target.value })} maxLength={500} placeholder={t('fees.changeNoteHint')} />
              <p className="text-xs text-muted-foreground">{tn('fees.newVersionText', fee?.linkedServices ?? 0)}</p>
            </div>
          ) : null}
          <div className="space-y-1.5">
            <Label htmlFor="f-source">{t('fees.sourceUrl')}</Label>
            <Input id="f-source" value={v.sourceUrl} onChange={(e) => set({ sourceUrl: e.target.value })} placeholder="https://" dir="ltr" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="f-notes">{t('fees.notes')}</Label>
            <Textarea id="f-notes" rows={2} value={v.notes} onChange={(e) => set({ notes: e.target.value })} maxLength={1000} />
          </div>
          <div className="flex flex-wrap gap-6">
            <label className="flex items-center gap-2 text-sm">
              <Switch checked={v.isSample} onCheckedChange={(x) => set({ isSample: x })} />
              {t('fees.isSample')}
            </label>
            <label className="flex items-center gap-2 text-sm">
              <Switch checked={v.isActive} onCheckedChange={(x) => set({ isActive: x })} />
              {t('fees.isActive')}
            </label>
          </div>
          {fee && history.data?.length ? (
            <section aria-labelledby="fee-history" className="space-y-2">
              <h3 id="fee-history" className="text-sm font-semibold">
                {t('fees.history')}
              </h3>
              <ul className="divide-y rounded-md border text-sm">
                {history.data.map((h) => (
                  <li key={h.version} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                    <span>
                      <span className="font-medium tabular">v{h.version}</span> <span className="text-muted-foreground">{formatDateTime(h.createdAt)}</span>
                      {h.note ? <span className="block text-xs text-muted-foreground">{h.note}</span> : null}
                    </span>
                    <span className="tabular">
                      {formatMoney(h.governmentFeeBefore)} → {formatMoney(h.governmentFeeAfter)}
                      {h.thirdPartyFeeBefore !== h.thirdPartyFeeAfter ? ` · ${formatMoney(h.thirdPartyFeeBefore)} → ${formatMoney(h.thirdPartyFeeAfter)}` : ''}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {save.error ? <Alert tone="danger">{describe(save.error)}</Alert> : null}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button onClick={() => save.mutate()} loading={save.isPending} disabled={!v.name.trim() || !v.governmentFee || (!fee && v.code.length < 2)}>
            {t('common.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
