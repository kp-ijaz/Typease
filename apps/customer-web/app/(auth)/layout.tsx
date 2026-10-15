import { AuthLayout } from '@typease/ui';

export default function AuthGroupLayout({ children }: { children: React.ReactNode }) {
  return <AuthLayout homeHref="/">{children}</AuthLayout>;
}
