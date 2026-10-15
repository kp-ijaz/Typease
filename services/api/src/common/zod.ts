import { createZodDto } from 'nestjs-zod';
import type { ZodTypeAny } from 'zod';

/** Turns a shared Zod schema into a Nest DTO (validated by the global pipe, documented in OpenAPI). */
export const dto = <T extends ZodTypeAny>(schema: T) => createZodDto(schema as any) as unknown as new () => import('zod').infer<T>;
