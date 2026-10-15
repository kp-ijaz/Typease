// Only for type-checking this package on its own (it has no @types/node).
// The apps bring the real Node / Next.js typings.
declare const process: { env: { NODE_ENV?: string; NEXT_PUBLIC_DEMO_PASSWORD?: string } };
