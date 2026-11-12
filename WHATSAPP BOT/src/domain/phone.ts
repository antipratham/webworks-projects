import { AppError } from './errors.js';

/**
 * Cross-cutting rule: phone numbers are normalised to E.164 by a SINGLE shared
 * helper before any lookup or write. Input accepts 10 digits, a 0 prefix, +91
 * and spaces. First digit must be 6-9.
 *
 * This function is that helper. Nothing else in the codebase may parse a phone
 * number — if you find yourself writing `.replace(/\D/g, '')` somewhere else,
 * you are creating the bug where the same guest exists twice.
 */
export function toE164(input: string, defaultCountry = '91'): string {
  const raw = String(input).trim();
  const hasPlus = raw.startsWith('+');
  let digits = raw.replace(/\D/g, '');

  if (hasPlus) {
    // Already international. Trust the country code as given.
    if (digits.length < 11 || digits.length > 15) {
      throw new AppError('PHONE_INVALID', 'Phone number length is not valid for E.164.', {
        field: 'phone',
      });
    }
    return `+${digits}`;
  }

  // Domestic forms: 0XXXXXXXXXX, 91XXXXXXXXXX, XXXXXXXXXX
  if (digits.startsWith('0')) digits = digits.slice(1);
  if (digits.length === 12 && digits.startsWith(defaultCountry)) {
    digits = digits.slice(defaultCountry.length);
  }

  if (digits.length !== 10) {
    throw new AppError('PHONE_INVALID', 'Indian mobile numbers must be 10 digits.', {
      field: 'phone',
    });
  }

  const first = digits.charCodeAt(0) - 48;
  if (first < 6 || first > 9) {
    throw new AppError('PHONE_INVALID', 'Indian mobile numbers start with 6, 7, 8 or 9.', {
      field: 'phone',
    });
  }

  return `+${defaultCountry}${digits}`;
}

/**
 * Meta's webhooks return the sender as digits with no leading `+`
 * (e.g. `919876543210`). Bring it back to our canonical form.
 */
export function fromMetaWaId(waId: string): string {
  return toE164(`+${waId.replace(/\D/g, '')}`);
}

/** Graph API wants the number without the leading `+`. */
export function toMetaRecipient(e164: string): string {
  return e164.replace(/^\+/, '');
}
