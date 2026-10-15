import { StaffShell } from '@/components/staff-shell';

export default function AppGroupLayout({ children }: { children: React.ReactNode }) {
  return <StaffShell>{children}</StaffShell>;
}
