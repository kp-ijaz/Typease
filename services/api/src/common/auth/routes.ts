import type { INestApplicationContext } from '@nestjs/common';
import { MetadataScanner, ModulesContainer } from '@nestjs/core';
import { ACCESS_KEY, AccessRule } from './access';
import { SUPPORT_KEY, SupportRouteRule } from './support-session';

const METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'ALL', 'OPTIONS', 'HEAD', 'SEARCH'];

export interface DiscoveredRoute {
  /** Controller tag (API reference grouping). */
  tag: string;
  method: string;
  /** Full path with `:param` placeholders, e.g. `/api/v1/customers/:id`. */
  path: string;
  /** `Controller.method` */
  handler: string;
  rule: AccessRule | undefined;
  support: SupportRouteRule | undefined;
}

/**
 * Every HTTP route of the booted application with its access declaration, read
 * from the controller metadata. One implementation for the API reference
 * (src/cli/openapi.ts) and for the tests that walk all routes, so neither can
 * miss a route the other one sees.
 */
export function discoverRoutes(app: INestApplicationContext): DiscoveredRoute[] {
  const scanner = new MetadataScanner();
  const rows: DiscoveredRoute[] = [];
  for (const mod of app.get(ModulesContainer, { strict: false }).values()) {
    for (const wrapper of mod.controllers.values()) {
      const instance: any = wrapper.instance;
      if (!instance) continue;
      const ctor = instance.constructor;
      const base = [Reflect.getMetadata('path', ctor) ?? ''].flat()[0] as string;
      const tag = (Reflect.getMetadata('swagger/apiUseTags', ctor) ?? [ctor.name.replace(/Controller$/, '')])[0];
      const proto = Object.getPrototypeOf(instance);
      for (const name of scanner.getAllMethodNames(proto)) {
        const handler = proto[name];
        const sub = Reflect.getMetadata('path', handler);
        if (sub === undefined) continue;
        const method = METHODS[Reflect.getMetadata('method', handler) ?? 0] ?? 'GET';
        const rule: AccessRule | undefined = Reflect.getMetadata(ACCESS_KEY, handler) ?? Reflect.getMetadata(ACCESS_KEY, ctor);
        const support: SupportRouteRule | undefined = Reflect.getMetadata(SUPPORT_KEY, handler) ?? Reflect.getMetadata(SUPPORT_KEY, ctor);
        for (const p of [sub].flat()) {
          const isHealth = base === 'health';
          const path = `${isHealth ? '' : '/api/v1'}/${[base, p].filter((x) => x && x !== '/').join('/')}`.replace(/\/+/g, '/');
          rows.push({ tag, method, path, handler: `${ctor.name}.${name}`, rule, support });
        }
      }
    }
  }
  return rows.sort((a, b) => a.tag.localeCompare(b.tag) || a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
}
