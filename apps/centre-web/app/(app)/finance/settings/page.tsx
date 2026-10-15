import { pageTitle } from '@/lib/metadata';
import { InvoiceReminderSettingsCard } from '@/components/fin/invoice-reminders';
import { FeeSettings } from './settings';

export const generateMetadata = () => pageTitle('fin.feeSettings.title');

export default function Page() {
  return (
    <>
      <FeeSettings />
      <InvoiceReminderSettingsCard />
    </>
  );
}
