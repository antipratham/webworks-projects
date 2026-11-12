/**
 * One set of realistic parameters per event, shared by every test that needs to
 * build a message. Keeping them in one place means a new template variable
 * breaks the suite once, not in four files.
 */
export const SAMPLES: Record<string, Record<string, unknown>> = {
  BOOKING_CONFIRMED: {
    guestName: 'Asha',
    outletName: 'The Table',
    partySize: 4,
    dateTimeLabel: 'Sat 4 Oct, 8:00 pm',
    manageToken: 'abcd1234efgh',
  },
  CALL_FALLBACK_BOOKING_LINK: { outletName: 'The Table', bookingToken: 'abcd1234efgh' },
  CALLBACK_ACK: { outletName: 'The Table', bookingToken: 'abcd1234efgh' },
  DEPOSIT_PAYMENT_REQUEST: {
    guestName: 'Asha',
    outletName: 'The Table',
    amountLabel: '₹2,000',
    dateTimeLabel: 'Sat 4 Oct, 8:00 pm',
    holdExpiryLabel: '30 minutes',
    payToken: 'abcd1234efgh',
  },
  BOOKING_REMINDER_T24: {
    guestName: 'Asha',
    outletName: 'The Table',
    partySize: 4,
    dateTimeLabel: 'Sat 4 Oct, 8:00 pm',
    bookingId: 'bk_123',
  },
  BOOKING_REMINDER_T2: {
    guestName: 'Asha',
    outletName: 'The Table',
    partySize: 4,
    dateTimeLabel: 'Sat 4 Oct, 8:00 pm',
    bookingId: 'bk_123',
  },
  WAITLIST_ADDED: {
    guestName: 'Asha',
    outletName: 'The Table',
    position: 3,
    waitMinutes: 25,
    statusToken: 'abcd1234efgh',
  },
  WAITLIST_TABLE_READY: { guestName: 'Asha', outletName: 'The Table', holdMinutes: 10 },
  LOYALTY_POINTS_POSTED: {
    guestName: 'Asha',
    outletName: 'The Table',
    pointsEarned: 120,
    balance: 860,
    tierName: 'Gold',
    walletToken: 'abcd1234efgh',
  },
  FEEDBACK_REQUEST: { guestName: 'Asha', outletName: 'The Table', visitId: 'vs_9' },
  EVENT_TICKET_ISSUED: {
    guestName: 'Asha',
    outletName: 'The Table',
    eventName: 'Diwali Supper Club',
    dateTimeLabel: 'Sun 19 Oct, 7:30 pm',
    tierName: 'Early bird',
    quantity: 2,
    qrImageUrl: 'https://cdn.example.com/t/abc.png',
    ticketToken: 'abcd1234efgh',
  },
  MARKETING_CAMPAIGN: {
    templateName: 'winback_60d_v1',
    bodyParams: ['Asha', 'The Table'],
    campaignId: 'cmp_1',
  },
};
