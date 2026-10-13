import { ShipmentStatus } from '@prisma/client';

// The steps a driver moves a trip through, in order. Shared by the two routes that
// advance a trip (PATCH /shipments/:id/status and the driver app's
// POST /operations/shipments/:id/progress) so they cannot drift apart.
export const DRIVER_TRIP_STEPS: ShipmentStatus[] = [
  'DRIVER_ASSIGNED',
  'DRIVER_EN_ROUTE',
  'ARRIVED_PICKUP',
  'PICKED_UP',
  'IN_TRANSIT',
  'ARRIVED_DESTINATION',
  'DELIVERED',
];

// Forward along the driver's own steps only. Intermediate steps may be skipped (the app
// sends "picked up" and "in transit" back to back, and the second can be lost on a bad
// connection), but a trip can never be rewound or pushed into a payment or completion
// state this way.
export function isForwardTripStep(current: ShipmentStatus, next: ShipmentStatus) {
  const from = DRIVER_TRIP_STEPS.indexOf(current);
  const to = DRIVER_TRIP_STEPS.indexOf(next);
  return from >= 0 && to > from;
}

export type CustomerStatusAlert = { title: string; body: string; tone: 'INFO' | 'SUCCESS' | 'WARNING' };

// What the customer is told when the driver or operations move their shipment along.
// Statuses not listed either notify through their own flow (proof of delivery, disputes,
// escrow release) or are internal steps the customer does not act on.
const CUSTOMER_STATUS_ALERTS: Partial<Record<ShipmentStatus, CustomerStatusAlert>> = {
  DRIVER_EN_ROUTE: { title: 'Driver on the way to pickup', body: 'Your driver is heading to the pickup address for {reference}.', tone: 'INFO' },
  ARRIVED_PICKUP: { title: 'Driver at pickup', body: 'Your driver has arrived at the pickup address for {reference}.', tone: 'INFO' },
  PICKED_UP: { title: 'Cargo picked up', body: 'Your cargo for {reference} has been loaded.', tone: 'SUCCESS' },
  IN_TRANSIT: { title: 'Shipment on the road', body: '{reference} is on its way. You can follow the truck on the live map.', tone: 'INFO' },
  ARRIVED_DESTINATION: { title: 'Driver at destination', body: 'Your driver has arrived at the destination for {reference}.', tone: 'INFO' },
  DELIVERED: { title: 'Delivery awaiting your confirmation', body: '{reference} was marked delivered. Check the cargo, then confirm receipt in the app.', tone: 'SUCCESS' },
  CANCELLED: { title: 'Shipment cancelled', body: '{reference} was cancelled. Contact support if you did not expect this.', tone: 'WARNING' },
};

export function customerStatusAlert(status: ShipmentStatus, reference: string): CustomerStatusAlert | undefined {
  const alert = CUSTOMER_STATUS_ALERTS[status];
  return alert && { ...alert, body: alert.body.replace('{reference}', reference) };
}
