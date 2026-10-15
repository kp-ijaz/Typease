import { pageTitle } from '@/lib/metadata';
import { ServiceEditor } from './service-editor';

export const generateMetadata = () => pageTitle('ops.services.editor.title');

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ServiceEditor id={id} />;
}
