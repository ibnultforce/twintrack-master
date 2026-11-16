import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { listBodyFieldOptions } from '../src/lib/bodyFieldOptions.js';
import { createApp } from '../src/app.js';
import { findBodySchema } from '../src/lib/apiRoute.js';
import { createTestConfig } from './helpers/testConfig.js';

describe('fixed values a body field accepts', () => {
  it('reads choices, yes or no, nullable choices and lists of choices, and skips free input', () => {
    const schema = z.strictObject({
      status: z.enum(['active', 'on_hold', 'done']).optional(),
      billable: z.boolean(),
      team: z.enum(['a', 'b']).nullable().optional(),
      actions: z.array(z.enum(['read', 'create'])),
      name: z.string(),
      deadline: z.string().nullable(),
    });
    expect(listBodyFieldOptions(schema)).toEqual([
      { field: 'status', values: ['active', 'on_hold', 'done'], isMany: false },
      { field: 'billable', values: [true, false], isMany: false },
      { field: 'team', values: ['a', 'b', null], isMany: false },
      { field: 'actions', values: ['read', 'create'], isMany: true },
    ]);
  });

  it('finds a registered API\'s body schema, as its handler checks it', () => {
    createApp(createTestConfig());
    const options = listBodyFieldOptions(findBodySchema('PATCH /projects/projects/:id')!);
    expect(options.find((option) => option.field === 'status')?.values.length).toBeGreaterThan(1);
  });
});
