import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { EVENT_TYPES, LOCALES, TEMPLATES, getTemplate } from '../src/templates/registry.js';
import { buildTemplateMessage, buildListMessage, buildButtonMessage } from '../src/whatsapp/payloads.js';
import { SAMPLES } from './fixtures.js';

/**
 * These tests exist for one reason: Meta rejects a template send whose variable
 * count does not match what it approved, and it does so at run time, to a real
 * guest. Asserting the built payload here moves that failure to CI.
 */

describe('template registry', () => {
  test('every declared event has a sample and validates against its own schema', () => {
    for (const event of EVENT_TYPES) {
      const sample = SAMPLES[event];
      assert.ok(sample, `no sample params for ${event}`);
      const parsed = getTemplate(event).params.safeParse(sample);
      assert.ok(parsed.success, `sample for ${event} fails its schema`);
    }
  });

  test('template names are unique and lowercase, as Meta requires', () => {
    const names = Object.values(TEMPLATES)
      .map((t) => t.name)
      .filter((n) => n !== '__dynamic__');
    assert.equal(new Set(names).size, names.length, 'duplicate template name');
    for (const name of names) {
      assert.match(name, /^[a-z0-9_]+$/, `${name} is not a legal template name`);
    }
  });

  test('every event builds a payload Meta will accept in every supported language', () => {
    for (const event of EVENT_TYPES) {
      const def = getTemplate(event);
      const params = def.params.parse(SAMPLES[event]);

      for (const locale of LOCALES) {
        const body = buildTemplateMessage(def, params, '+919876543210', locale);

        assert.equal(body.messaging_product, 'whatsapp');
        assert.equal(body.to, '919876543210', 'recipient must have no leading +');
        assert.equal(body.type, 'template');

        const template = body.template as {
          name: string;
          language: { code: string };
          components?: { type: string; parameters?: unknown[] }[];
        };
        assert.equal(template.language.code, locale);

        const bodyComponent = template.components?.find((c) => c.type === 'body');
        const expected = def.body(params).length;
        assert.equal(
          bodyComponent?.parameters?.length ?? 0,
          expected,
          `${event}: body variable count drifted from the registry`,
        );

        // No variable may be empty — Meta rejects an empty positional parameter.
        for (const p of (bodyComponent?.parameters ?? []) as { text: string }[]) {
          assert.ok(p.text.length > 0, `${event}: empty body variable`);
        }
      }
    }
  });

  test('url buttons carry only a suffix, never a full url', () => {
    for (const event of EVENT_TYPES) {
      const def = getTemplate(event);
      for (const button of def.buttons ?? []) {
        if (button.kind !== 'url') continue;
        const suffix = button.suffix(def.params.parse(SAMPLES[event]));
        assert.ok(
          !suffix.includes('://'),
          `${event}: URL button suffix must not contain a scheme — the base domain is fixed at approval`,
        );
      }
    }
  });
});

describe('interactive payloads', () => {
  test('the rating list holds exactly ten rows and one tap each', () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({ id: `RATE:${i + 1}`, title: String(i + 1) }));
    const msg = buildListMessage('+919876543210', {
      body: 'Out of 10?',
      buttonLabel: 'Rate 1-10',
      rows,
    });
    const action = (msg.interactive as { action: { sections: { rows: unknown[] }[] } }).action;
    assert.equal(action.sections[0]!.rows.length, 10);
  });

  test('a list may not exceed ten rows — this is why the scale is 1-10, not 0-10', () => {
    const rows = Array.from({ length: 11 }, (_, i) => ({ id: `RATE:${i}`, title: String(i) }));
    assert.throws(
      () => buildListMessage('+919876543210', { body: 'x', buttonLabel: 'y', rows }),
      /1-10 rows/,
    );
  });

  test('reply buttons cap at three and truncate long titles', () => {
    assert.throws(
      () =>
        buildButtonMessage('+919876543210', {
          body: 'x',
          buttons: [1, 2, 3, 4].map((n) => ({ id: `B${n}`, title: `Button ${n}` })),
        }),
      /1-3/,
    );

    const msg = buildButtonMessage('+919876543210', {
      body: 'How was the food?',
      buttons: [{ id: 'Q1:GOOD', title: 'An extremely long button label' }],
    });
    const buttons = (msg.interactive as { action: { buttons: { reply: { title: string } }[] } })
      .action.buttons;
    assert.equal(buttons[0]!.reply.title.length, 20);
  });
});
