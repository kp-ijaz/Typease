import { pageTitle } from '@/lib/metadata';
import { OnboardingWizard } from './onboarding-wizard';

export const generateMetadata = () => pageTitle('adm.onboarding.title');

export default function Page() {
  return <OnboardingWizard />;
}
