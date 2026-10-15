import type { Dictionary } from '@typease/ui/server';
import { side, type Tree } from '../pairs';
import { billing, coupons, planAdmin } from './billing';
import { dash, pc } from './dashboard';
import { fees } from './fees';
import { apiErrors, audit, flags, health, integ, staff } from './platform';
import { access, desk } from './support';
import { tenants } from './tenants';

/**
 * Every namespace the screens of the console use, English and Arabic derived from the same
 * tree. `apiErrors` extends the shared block of the same name (dictionaries are merged deeply).
 */
const tree: Tree = { pc, dash, tenants, billing, coupons, planAdmin, desk, access, flags, fees, integ, health, audit, staff, apiErrors };

export const sectionsEn: Dictionary = side(tree, 0);
export const sectionsAr: Dictionary = side(tree, 1);
