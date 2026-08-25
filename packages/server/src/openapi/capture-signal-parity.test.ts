/**
 * `disabled_signals` parity across the three places it is written down.
 *
 * The value is produced by `analysis-core`'s `CAPTURE_SIGNALS`, validated by the
 * Zod schema in `@provenance/shared`, and documented by the OpenAPI component.
 * Nothing forces the three to agree: a retired signal name left in the Zod enum
 * or the OpenAPI enum is merely unreachable, so it typechecks, lints, and passes
 * every other test while quietly telling API consumers that a knob still exists.
 *
 * Both `doc_open_close` and `inline_content` rotted exactly that way. This pins
 * the set so the next removal has to be made in all three files or fail here.
 */

import { describe, it, expect } from 'vitest';
import { CAPTURE_SIGNALS } from '@provenance/analysis-core';
import { AssignmentManifestSchema } from '@provenance/shared/api-schemas';
import { openApiSpec } from './spec/index.js';

/** The single source of truth: what a course can actually switch off today. */
const EXPECTED = ['selection_change', 'focus_change', 'terminal'];

function zodEnumValues(): string[] {
  const shape = AssignmentManifestSchema.shape.disabled_signals;
  // z.array(z.enum([...])) — reach through to the element enum's options.
  const element = shape.element as { options: string[] };
  return [...element.options];
}

function openApiEnumValues(): string[] {
  const schemas = openApiSpec.components?.schemas as Record<string, unknown> | undefined;
  const manifest = schemas?.['AssignmentManifest'] as {
    properties: { disabled_signals: { items: { enum: string[] } } };
  };
  return [...manifest.properties.disabled_signals.items.enum];
}

describe('disabled_signals enum parity', () => {
  it('analysis-core produces exactly the gated signals that still exist', () => {
    expect([...CAPTURE_SIGNALS].sort()).toEqual([...EXPECTED].sort());
  });

  it('the shared Zod enum matches analysis-core', () => {
    expect(zodEnumValues().sort()).toEqual([...CAPTURE_SIGNALS].sort());
  });

  it('the OpenAPI component enum matches the shared Zod enum', () => {
    expect(openApiEnumValues().sort()).toEqual(zodEnumValues().sort());
  });

  it.each(['doc_open_close', 'inline_content'])(
    'does not advertise the retired %s signal anywhere',
    (retired) => {
      expect(CAPTURE_SIGNALS as readonly string[]).not.toContain(retired);
      expect(zodEnumValues()).not.toContain(retired);
      expect(openApiEnumValues()).not.toContain(retired);
    },
  );
});
