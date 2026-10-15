/**
 * Scenario DSL of the acceptance suite, on top of services/api/test/helpers.ts.
 * Everything in here drives the application through its public HTTP API. The
 * one exception is isolation.ts (evidence read from the database for the
 * security suite); see tests/README.md, "Rules of the suite".
 */
export { PASSWORD, TestApp, uniq } from '../../services/api/test/helpers';
export type { Actor, TenantFixture } from '../../services/api/test/helpers';
export * from './http';
export * from './centre';
export * from './documents';
export * from './files';
export * from './finance';
export * from './jobs';
export * from './money';
export * from './journey';
export * from './books';
export * from './world';
export * from './routes';
export * from './isolation';
export * from './attacks';
