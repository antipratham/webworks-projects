import { toMetaRecipient } from '../domain/phone.js';
import { META_LANGUAGE, type AnyTemplateDefinition, type Locale } from '../templates/registry.js';

/**
 * Builders for the exact JSON the Graph API expects.
 *
 * Everything here is pure: given params, it returns a body. That makes the
 * payload for every template assertable in a unit test without a network call,
 * which is the only practical way to catch a variable-count mistake before Meta
 * does.
 */

type Component = Record<string, unknown>;

export interface GraphMessageBody {
  messaging_product: 'whatsapp';
  recipient_type: 'individual';
  to: string;
  type: string;
  [k: string]: unknown;
}

/** A business-initiated message. Always a template — there is no other option. */
export function buildTemplateMessage(
  def: AnyTemplateDefinition,
  params: Record<string, unknown>,
  toE164Number: string,
  locale: Locale,
  templateNameOverride?: string,
): GraphMessageBody {
  const components: Component[] = [];

  if (def.mediaHeader) {
    const media = def.mediaHeader(params);
    components.push({
      type: 'header',
      parameters: [{ type: media.type, [media.type]: { link: media.link } }],
    });
  } else if (def.headerText) {
    components.push({
      type: 'header',
      parameters: [{ type: 'text', text: def.headerText(params) }],
    });
  }

  const bodyVars = def.body(params);
  if (bodyVars.length > 0) {
    components.push({
      type: 'body',
      parameters: bodyVars.map((text) => ({ type: 'text', text })),
    });
  }

  for (const button of def.buttons ?? []) {
    if (button.kind === 'url') {
      components.push({
        type: 'button',
        sub_type: 'url',
        index: String(button.index),
        // Only the SUFFIX travels. The base domain was fixed at approval time.
        parameters: [{ type: 'text', text: button.suffix(params) }],
      });
    } else {
      components.push({
        type: 'button',
        sub_type: 'quick_reply',
        index: String(button.index),
        parameters: [{ type: 'payload', payload: button.payload(params) }],
      });
    }
  }

  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: toMetaRecipient(toE164Number),
    type: 'template',
    template: {
      name: templateNameOverride ?? def.name,
      language: { code: META_LANGUAGE[locale] },
      ...(components.length ? { components } : {}),
    },
  };
}

/**
 * Free-form text. Only legal inside an open 24-hour service window, which means
 * only after the guest has messaged or tapped a button first.
 */
export function buildTextMessage(toE164Number: string, body: string): GraphMessageBody {
  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: toMetaRecipient(toE164Number),
    type: 'text',
    text: { preview_url: false, body },
  };
}

export interface ListRow {
  id: string;
  title: string;
  description?: string;
}

/**
 * Interactive list: up to 10 rows.
 *
 * This is what carries the 1-10 rating. It is a free-form message, so it can
 * only be sent once the guest's tap on the feedback template has opened the
 * window. Ten rows is exactly the budget — which is why the scale is 1-10 and
 * not the textbook 0-10.
 */
export function buildListMessage(
  toE164Number: string,
  opts: { body: string; buttonLabel: string; rows: ListRow[]; header?: string; footer?: string },
): GraphMessageBody {
  if (opts.rows.length === 0 || opts.rows.length > 10) {
    throw new Error(`Interactive list must carry 1-10 rows, got ${opts.rows.length}.`);
  }
  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: toMetaRecipient(toE164Number),
    type: 'interactive',
    interactive: {
      type: 'list',
      ...(opts.header ? { header: { type: 'text', text: opts.header } } : {}),
      body: { text: opts.body },
      ...(opts.footer ? { footer: { text: opts.footer } } : {}),
      action: {
        button: opts.buttonLabel,
        sections: [{ rows: opts.rows.map((r) => ({ id: r.id, title: r.title, ...(r.description ? { description: r.description } : {}) })) }],
      },
    },
  };
}

/** Interactive reply buttons: at most 3. Also window-only. */
export function buildButtonMessage(
  toE164Number: string,
  opts: { body: string; buttons: { id: string; title: string }[]; footer?: string },
): GraphMessageBody {
  if (opts.buttons.length === 0 || opts.buttons.length > 3) {
    throw new Error(`Interactive reply buttons must number 1-3, got ${opts.buttons.length}.`);
  }
  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: toMetaRecipient(toE164Number),
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: opts.body },
      ...(opts.footer ? { footer: { text: opts.footer } } : {}),
      action: {
        buttons: opts.buttons.map((b) => ({
          type: 'reply',
          reply: { id: b.id, title: b.title.slice(0, 20) },
        })),
      },
    },
  };
}
