import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { EVENT_TYPES, getTemplate } from '../src/templates/registry.js';
import { PREVIEWS, variableCount, render } from '../src/templates/approvalCopy.js';
import { SAMPLES } from './fixtures.js';

/**
 * Keeps the copy deck honest.
 *
 * src/templates/approvalCopy.ts holds the exact body copy submitted to Meta. If
 * its {{n}} placeholders drift from the registry's `body()`, the approved
 * template rejects every live send with error 132000 — at run time, to a real
 * guest. So the two are asserted equal here instead.
 */
describe('template copy deck', () => {
  test('placeholder count matches the registry, template by template', () => {
    for (const event of EVENT_TYPES) {
      const def = getTemplate(event);
      if (def.name === '__dynamic__') continue;

      assert.ok(PREVIEWS[def.name], `no approval copy written for ${def.name} (${event})`);

      const expected = def.body(def.params.parse(SAMPLES[event])).length;
      assert.equal(
        variableCount(def.name),
        expected,
        `${def.name}: copy uses ${variableCount(def.name)} variables, registry sends ${expected}`,
      );
    }
  });

  test('button labels are declared for every button the registry sends', () => {
    for (const event of EVENT_TYPES) {
      const def = getTemplate(event);
      if (def.name === '__dynamic__') continue;

      const declared = PREVIEWS[def.name]!.buttons?.length ?? 0;
      assert.equal(
        declared,
        def.buttons?.length ?? 0,
        `${def.name}: copy declares ${declared} buttons, registry sends ${def.buttons?.length ?? 0}`,
      );
    }
  });

  test('rendering leaves no unsubstituted placeholders', () => {
    for (const event of EVENT_TYPES) {
      const def = getTemplate(event);
      if (def.name === '__dynamic__') continue;

      const vars = def.body(def.params.parse(SAMPLES[event]));
      const { rendered } = render(def.name, vars);
      assert.doesNotMatch(rendered, /\{\{\d+\}\}/, `${def.name}: a placeholder was left unfilled`);
    }
  });

  test('URL button bases are absolute and fixed — only the suffix varies', () => {
    for (const preview of Object.values(PREVIEWS)) {
      for (const button of preview.buttons ?? []) {
        if (button.kind !== 'url') continue;
        assert.match(button.baseUrl ?? '', /^https:\/\/[^{]+\/$/, 'URL base must be a fixed https prefix');
      }
    }
  });
});
