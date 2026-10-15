import { BadgeCheck, Briefcase, Building2, FileText, Folder, Home, IdCard, Languages, LayoutGrid, Plane, Printer, Stamp, Star, type LucideIcon } from 'lucide-react';

/** Icon names stored with service categories (packages/types DEFAULT_SERVICE_CATEGORIES) -> icons. */
const ICONS: Record<string, LucideIcon> = {
  'file-text': FileText, plane: Plane, home: Home, 'id-card': IdCard, briefcase: Briefcase, building: Building2, stamp: Stamp, 'badge-check': BadgeCheck,
  languages: Languages, printer: Printer, folder: Folder, star: Star,
};
export const categoryIcon = (name: string | null | undefined): LucideIcon => (name && ICONS[name]) || LayoutGrid;

/** Solid icon tiles as in the brand reference, cycling through the theme's tones (so they follow a centre's colours). */
export const TILE_TONES = [
  'bg-secondary text-secondary-foreground',
  'bg-accent text-accent-foreground',
  'bg-primary text-primary-foreground',
  'bg-warning text-warning-foreground',
  'bg-info text-info-foreground',
  'bg-success text-success-foreground',
] as const;
