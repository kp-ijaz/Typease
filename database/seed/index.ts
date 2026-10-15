/**
 * The fictional demo data set of TypEase.
 *
 * These modules are DATA: who the demo centres are, who works there, who their
 * customers are and what happened to each request. The program that turns them
 * into rows - by driving the real API - is services/api/src/cli/seed.ts.
 *
 * Nothing here describes a real person, company, authority reference or
 * identity document. See docs/DEMO_ENVIRONMENT.md.
 */
import type { DemoFixtures } from '../../services/api/src/cli/seed/fixture-types';
import { formValues } from './forms';
import { identity } from './identity';
import { platform } from './platform';
import { alNoor } from './tenants/al-noor';
import { desertRose } from './tenants/desert-rose';
import { gulfStar } from './tenants/gulf-star';

export const DEMO: DemoFixtures = {
  identity,
  platform,
  tenants: [alNoor, gulfStar, desertRose],
  formValues,
  defaults: { passwordEnv: 'DEMO_PASSWORD', password: 'TypEase-Demo-2026' },
};
