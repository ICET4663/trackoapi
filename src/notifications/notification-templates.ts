// Admin-editable notification message templates. Each entry's `defaultBody` is
// the copy shipped with the product; an admin can override it per key from the
// Platform settings screen (the keys are appended to the platform-setting
// catalogue, so they persist and audit-log through the existing machinery).
//
// NotificationsService.create() resolves `templateKey` -> stored override (or
// this default) and interpolates `{placeholder}` tokens from `vars`. Call sites
// still pass a literal `body` as a last-resort fallback, so a missing or broken
// template can never drop a notification.

export type NotificationTemplateDefinition = {
  key: string;
  title: string;
  description: string;
  /** Placeholder names the call site fills, shown to the admin as guidance. */
  placeholders: string[];
  defaultBody: string;
};

export const NOTIFICATION_TEMPLATE_PREFIX = 'notifyTpl.';

export const NOTIFICATION_TEMPLATES: NotificationTemplateDefinition[] = [
  {
    key: 'notifyTpl.customerEscrowFunded',
    title: 'Customer · escrow funded',
    description: 'Sent to the customer once their Paystack payment is verified and escrow is held.',
    placeholders: ['amount', 'reference'],
    defaultBody: '{amount} has been secured for shipment {reference}. Admin review is now ready.',
  },
  {
    key: 'notifyTpl.customerDriverAccepted',
    title: 'Customer · driver accepted',
    description: 'Sent to the customer when the assigned driver accepts the shipment.',
    placeholders: ['reference'],
    defaultBody: 'Your driver accepted the shipment and is heading to pickup.',
  },
  {
    key: 'notifyTpl.customerProofSubmitted',
    title: 'Customer · proof of delivery submitted',
    description: 'Sent to the customer when the driver uploads proof of delivery for review.',
    placeholders: ['reference'],
    defaultBody: 'The driver uploaded delivery proof for your shipment. Review it and confirm delivery to release escrow.',
  },
  {
    key: 'notifyTpl.dispatcherShipmentApproved',
    title: 'Dispatcher · shipment approved',
    description: 'Sent to dispatchers when an admin approves a funded shipment for driver matching.',
    placeholders: ['reference'],
    defaultBody: '{reference} was approved and is ready for driver assignment.',
  },
  {
    key: 'notifyTpl.driverNewOffer',
    title: 'Driver · new shipment offer',
    description: 'Sent to a driver when dispatch offers them a shipment.',
    placeholders: ['reference'],
    defaultBody: 'A dispatcher sent you a shipment assignment offer.',
  },
  {
    key: 'notifyTpl.driverEscrowReleased',
    title: 'Driver · escrow released',
    description: 'Sent to the assigned driver when platform operations release escrow for a completed delivery.',
    placeholders: ['amount', 'reference'],
    defaultBody: '{amount} for {reference} is now available for withdrawal.',
  },
  {
    key: 'notifyTpl.driverWithdrawalApproved',
    title: 'Driver · withdrawal approved',
    description: 'Sent to the driver when finance approves their payout request.',
    placeholders: ['amount'],
    defaultBody: 'Your withdrawal of {amount} was approved and is being processed to your bank account.',
  },
  {
    key: 'notifyTpl.driverWithdrawalPaid',
    title: 'Driver · withdrawal paid',
    description: 'Sent to the driver when finance marks their payout as paid.',
    placeholders: ['amount'],
    defaultBody: 'Your withdrawal of {amount} has been paid to your bank account.',
  },
];

const TEMPLATE_BY_KEY = new Map(NOTIFICATION_TEMPLATES.map((template) => [template.key, template]));

export function notificationTemplateDefault(key: string): string | undefined {
  return TEMPLATE_BY_KEY.get(key)?.defaultBody;
}

export function interpolateTemplate(template: string, vars: Record<string, string | number> = {}): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match,
  );
}
