import { notFound } from 'next/navigation';
import { pageTitle } from '@/lib/metadata';
import { Gallery } from './gallery';

export const generateMetadata = () => pageTitle('gallery.title');

/**
 * Development tool, not part of the product navigation. Available in
 * development, and in a production build only when ENABLE_DEV_GALLERY=true.
 */
export default function Page() {
  if (process.env.NODE_ENV === 'production' && process.env.ENABLE_DEV_GALLERY !== 'true') notFound();
  return <Gallery />;
}
