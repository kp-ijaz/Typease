import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { REQUEST_TRANSITIONS } from '@typease/types';
import { applyGeneratedSections, renderStateDiagram, renderTransitionTable } from './lifecycle-diagram';

const DOC = join(__dirname, '..', '..', '..', '..', '..', 'docs', 'workflows', 'REQUEST_LIFECYCLE.md');

describe('request lifecycle documentation', () => {
  it('renders every edge of the transition table', () => {
    const diagram = renderStateDiagram();
    const edges = Object.entries(REQUEST_TRANSITIONS).flatMap(([from, rules]) => rules.map((r) => `  ${from} --> ${r.to}: ${r.action}`));
    expect(edges.length).toBeGreaterThan(40);
    for (const edge of edges) expect(diagram).toContain(edge);
    // Nothing but the header, the entry point, the edges and the exits of the terminal statuses.
    expect(diagram.split('\n')).toHaveLength(2 + edges.length + 1);
    expect(diagram).toContain('  CANCELLED --> [*]');
    expect(renderTransitionTable().split('\n')).toHaveLength(2 + edges.length);
  });

  it('docs/workflows/REQUEST_LIFECYCLE.md shows exactly the implemented state machine', () => {
    expect(existsSync(DOC)).toBe(true);
    const current = readFileSync(DOC, 'utf8');
    const expected = applyGeneratedSections(current);
    // UPDATE_LIFECYCLE_DOC=1 rewrites the generated sections after the transition table changed.
    if (process.env.UPDATE_LIFECYCLE_DOC === '1' && expected !== current) writeFileSync(DOC, expected);
    else expect(current).toBe(expected);
  });
});
