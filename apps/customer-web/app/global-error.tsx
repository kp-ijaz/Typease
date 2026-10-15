'use client';

/**
 * Last line of defence: the root layout itself failed, so no providers, no
 * dictionaries and no stylesheet can be assumed. Plain HTML in both languages.
 */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: 'system-ui, sans-serif', margin: 0, minHeight: '100vh', display: 'grid', placeItems: 'center', background: '#F5F7FA', color: '#0F1B2D' }}>
        <main style={{ maxWidth: 440, padding: 32, textAlign: 'center' }}>
          <h1 style={{ fontSize: 22, margin: '0 0 8px' }}>This page could not be shown</h1>
          <p style={{ margin: '0 0 4px', color: '#566377' }}>An unexpected problem stopped the application. Your data is safe.</p>
          <p dir="rtl" lang="ar" style={{ margin: '0 0 20px', color: '#566377' }}>
            حدثت مشكلة غير متوقعة أوقفت التطبيق. بياناتك بأمان.
          </p>
          {error.digest ? <p style={{ fontSize: 13, color: '#566377' }}>Reference: {error.digest}</p> : null}
          <button type="button" onClick={reset} style={{ height: 40, padding: '0 20px', borderRadius: 8, border: 0, background: '#0B2240', color: '#fff', fontSize: 14, fontWeight: 500, cursor: 'pointer' }}>
            Try again / إعادة المحاولة
          </button>
        </main>
      </body>
    </html>
  );
}
