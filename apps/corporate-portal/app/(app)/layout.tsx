import { PortalShell } from '@/components/portal-shell';

export default function AppGroupLayout({ children }: { children: React.ReactNode }) {
  return <PortalShell>{children}</PortalShell>;
}
