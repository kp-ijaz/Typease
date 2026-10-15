import { REQUEST_STATUS_META, REQUEST_TRANSITIONS } from '@typease/types';
import type { RequestStatus } from '@typease/types';

/**
 * Renders the request state machine for the documentation, straight from the
 * transition table. `docs/workflows/REQUEST_LIFECYCLE.md` embeds this output
 * between markers, and a unit test fails when the document and the table
 * disagree - so the documented diagram is always the implemented one.
 */
const STATUSES = Object.keys(REQUEST_TRANSITIONS) as RequestStatus[];

export function renderStateDiagram(): string {
  const lines = ['stateDiagram-v2', '  [*] --> DRAFT'];
  for (const from of STATUSES) {
    for (const rule of REQUEST_TRANSITIONS[from]) lines.push(`  ${from} --> ${rule.to}: ${rule.action}`);
  }
  for (const status of STATUSES) if (!REQUEST_TRANSITIONS[status].length) lines.push(`  ${status} --> [*]`);
  return lines.join('\n');
}

export function renderTransitionTable(): string {
  const rows = ['| From | To | Action | Staff need one of | Customer | System | Reason required |', '| --- | --- | --- | --- | --- | --- | --- |'];
  for (const from of STATUSES) {
    for (const rule of REQUEST_TRANSITIONS[from]) {
      rows.push(`| ${from} | ${rule.to} | ${rule.action} | ${rule.staff.length ? rule.staff.map((p) => `\`${p}\``).join(', ') : '-'} | ${rule.customer ? 'yes' : '-'} | ${rule.system ? 'yes' : '-'} | ${rule.reason ? 'yes' : '-'} |`);
    }
  }
  return rows.join('\n');
}

export function renderStatusTable(): string {
  const rows = ['| Status | Staff see | Customers see |', '| --- | --- | --- |'];
  for (const status of STATUSES) rows.push(`| ${status} | ${REQUEST_STATUS_META[status].en} | ${REQUEST_STATUS_META[status].customerEn} |`);
  return rows.join('\n');
}

export const LIFECYCLE_SECTIONS: Record<string, () => string> = {
  'state-diagram': () => ['```mermaid', renderStateDiagram(), '```'].join('\n'),
  'transition-table': renderTransitionTable,
  'status-table': renderStatusTable,
};

/** Replaces every `<!-- generated:NAME -->...<!-- /generated:NAME -->` block with the current output. */
export function applyGeneratedSections(markdown: string): string {
  let out = markdown;
  for (const [name, render] of Object.entries(LIFECYCLE_SECTIONS)) {
    const pattern = new RegExp(`<!-- generated:${name} -->[\\s\\S]*?<!-- /generated:${name} -->`);
    if (!pattern.test(out)) throw new Error(`The lifecycle document has no "${name}" section.`);
    out = out.replace(pattern, () => `<!-- generated:${name} -->\n${render()}\n<!-- /generated:${name} -->`);
  }
  return out;
}
