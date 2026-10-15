import { DEFAULT_DOCUMENT_TYPES, DEFAULT_SERVICE_CATEGORIES } from '@typease/types';
import { serviceFormSchema, serviceSchema } from '@typease/validation';
import { STARTER_SERVICES } from './starter-catalogue';

describe('starter catalogue data', () => {
  it('has about a dozen services with unique codes spread over the categories', () => {
    expect(STARTER_SERVICES.length).toBeGreaterThanOrEqual(12);
    expect(new Set(STARTER_SERVICES.map((s) => s.code)).size).toBe(STARTER_SERVICES.length);
    expect(new Set(STARTER_SERVICES.map((s) => s.categoryKey)).size).toBeGreaterThanOrEqual(10);
  });
  it('never starts a service with a capability that needs an outside channel', () => {
    for (const s of STARTER_SERVICES) expect(['DOCUMENT_PREPARATION_ONLY', 'INFORMATIONAL_ONLY']).toContain(s.complianceCapability);
  });
  it.each(STARTER_SERVICES.map((s) => [s.code, s] as const))('%s satisfies the same rules as a service created through the API', (_code, s) => {
    expect(DEFAULT_SERVICE_CATEGORIES.map((c) => c.key)).toContain(s.categoryKey);
    const { requirements, form, categoryKey: _category, ...fields } = s;
    const parsed = serviceSchema.safeParse({ ...fields, categoryId: '00000000-0000-4000-8000-000000000000' });
    expect(parsed.success ? [] : parsed.error.issues).toEqual([]);
    for (const r of requirements) expect(DEFAULT_DOCUMENT_TYPES.map((d) => d.key)).toContain(r.documentTypeKey);
    if (form) {
      const checked = serviceFormSchema.safeParse(form);
      expect(checked.success ? [] : checked.error.issues).toEqual([]);
    }
  });
  it('does not claim to be, or to act as, an authority', () => {
    const text = JSON.stringify(STARTER_SERVICES).toLowerCase();
    for (const phrase of ['guaranteed approval', 'official government', 'government approved', 'we submit', 'authorised by the government']) expect(text).not.toContain(phrase);
  });
});
