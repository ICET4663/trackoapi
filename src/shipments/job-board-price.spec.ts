import { ConflictException } from '@nestjs/common';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { priceForCarrier, proposalBounds, priceRangePercentFrom, quotePartsFrom } from './job-board-price';
import { resetJobRequestTableForTests } from './job-board-store';
import { JobBoardService } from './job-board.service';
import { ShipmentsService } from './shipments.service';

// A Lagos-Abuja quote: trip pay NGN 200,000 + 10% commission = NGN 220,000. Running the trip
// (base fare, fuel, operating cost, tolls) costs NGN 170,000.
const breakdown = {
  carrierCostKobo: 20_000_000,
  commissionKobo: 2_000_000,
  commissionRate: 0.1,
  hiredDriverPayKobo: 6_000_000,
  baseFareKobo: 3_000_000,
  fuelCostKobo: 9_000_000,
  operatingCostKobo: 4_000_000,
  tollAllowanceKobo: 1_000_000,
  minimumFareAdjustmentKobo: 0,
  demandSurgeKobo: 3_000_000,
};
const QUOTE = 22_000_000;

describe('job board price rules', () => {
  const parts = quotePartsFrom(QUOTE, breakdown)!;

  it('reads trip pay, commission and running cost from the signed quote', () => {
    expect(parts).toMatchObject({ totalKobo: QUOTE, carrierKobo: 20_000_000, commissionKobo: 2_000_000, commissionRate: 0.1, runningCostKobo: 17_000_000 });
    expect(quotePartsFrom(QUOTE, { quotedPriceKobo: QUOTE })).toBeNull();
    expect(quotePartsFrom(null, breakdown)).toBeNull();
  });

  it('never lets the trip pay fall below the running cost, and keeps it within the range', () => {
    // 30% would allow NGN 140,000, but the trip costs NGN 170,000 to run.
    expect(proposalBounds(parts, 30)).toEqual({ minCarrierKobo: 17_000_000, maxCarrierKobo: 26_000_000 });
    expect(proposalBounds(parts, 10)).toEqual({ minCarrierKobo: 18_000_000, maxCarrierKobo: 22_000_000 });
    expect(proposalBounds(parts, 0)).toBeNull();
  });

  it('adds Trako commission at the quote rate, in whole naira', () => {
    expect(priceForCarrier(parts, 23_000_050)).toEqual({ carrierKobo: 23_000_100, commissionKobo: 2_300_000, totalKobo: 25_300_100 });
  });

  it('falls back to the default range for unusable settings', () => {
    expect(priceRangePercentFrom(undefined)).toBe(30);
    expect(priceRangePercentFrom('0')).toBe(0);
    expect(priceRangePercentFrom('150')).toBe(30);
    expect(priceRangePercentFrom('abc')).toBe(30);
  });
});

function unpaidShipment(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ship-1',
    reference: 'TRK-1',
    customerId: 'customer-1',
    status: 'PENDING_PAYMENT',
    adminApproved: false,
    adminApprovedAt: null,
    createdAt: new Date(),
    pickupLabel: 'Ikeja, Lagos',
    destinationLabel: 'Wuse, Abuja',
    pickupLatitude: 6.6,
    pickupLongitude: 3.35,
    destinationLatitude: 9.07,
    destinationLongitude: 7.48,
    cargoDescription: 'Cement',
    cargoWeightKg: 1000,
    cargoVolumeM3: null,
    quotedPriceKobo: QUOTE,
    customer: { email: 'customer@example.com' },
    ...overrides,
  };
}

function rawRouter(routes: Array<[string, unknown]>) {
  return jest.fn(async (sql: string) => {
    for (const [fragment, answer] of routes) {
      if (sql.includes(fragment)) return typeof answer === 'function' ? (answer as (...a: unknown[]) => unknown)() : answer;
    }
    return [];
  });
}

function build(prismaParts: Record<string, unknown>, rangeSetting?: string) {
  const notify = jest.fn().mockResolvedValue(null);
  const prisma = {
    $executeRawUnsafe: jest.fn().mockResolvedValue(0),
    $queryRawUnsafe: jest.fn().mockResolvedValue([]),
    auditLog: { findMany: jest.fn().mockResolvedValue([{ entityId: 'ship-1', metadata: { quotedPriceKobo: QUOTE, pricingBreakdown: breakdown } }]) },
    platformSetting: { findUnique: jest.fn().mockResolvedValue(rangeSetting === undefined ? null : { value: rangeSetting }) },
    driverAssignment: { findFirst: jest.fn().mockResolvedValue(null), create: jest.fn().mockResolvedValue({ id: 'assignment-1' }) },
    user: {
      findUnique: jest.fn()
        .mockResolvedValueOnce({ id: 'driver-1', email: 'driver@example.com', profile: { fullName: 'Musa Bello' } })
        .mockResolvedValueOnce({ email: 'customer@example.com' }),
    },
    ...prismaParts,
  } as unknown as PrismaService;
  const shipments = {
    isVehicleAssignmentReady: () => true,
    checkAssignmentEligibility: jest.fn().mockResolvedValue({ vehicle: { id: 'truck-1' } }),
  } as unknown as ShipmentsService;
  const service = new JobBoardService(prisma, shipments, { create: notify } as unknown as NotificationsService);
  return { service, notify, prisma, shipments };
}

const pendingEscrow = [{ status: 'PENDING', amount: QUOTE, platformFeeKobo: 2_000_000, driverPayKobo: 6_000_000 }];
const offer = {
  id: 'req-1', shipmentId: 'ship-1', driverId: 'driver-1', vehicleId: 'truck-1', status: 'PENDING',
  proposedCarrierKobo: 23_000_000, proposedPriceKobo: 25_300_000, proposedCommissionKobo: 2_300_000, priceAcceptedAt: null,
};

describe('JobBoardService price offers', () => {
  beforeEach(() => resetJobRequestTableForTests());

  it('stores a driver price with Trako commission on top and tells the customer', async () => {
    const query = rawRouter([['insert into "JobRequest"', [{ id: 'req-1' }]]]);
    const { service, notify } = build({ shipment: { findFirst: jest.fn().mockResolvedValue(unpaidShipment()) }, $queryRawUnsafe: query });

    await expect(service.request('driver-1', 'TRK-1', null, 23_000_000)).resolves.toEqual({ requestId: 'req-1', status: 'PENDING' });
    expect(query).toHaveBeenCalledWith(expect.stringContaining('insert into "JobRequest"'), expect.any(String), 'ship-1', 'driver-1', 'truck-1', null, null, 23_000_000, 25_300_000, 2_300_000);
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'customer-1',
      body: expect.stringContaining('for NGN 253,000 (your quote: NGN 220,000)'),
    }));
  });

  it('refuses a price below what the trip costs to run, or outside the range', async () => {
    const { service } = build({ shipment: { findFirst: jest.fn().mockResolvedValue(unpaidShipment()) } });
    await expect(service.request('driver-1', 'TRK-1', null, 15_000_000))
      .rejects.toThrow('Offer between NGN 170,000 (below that the trip does not cover fuel and running costs) and NGN 260,000');
    const again = build({ shipment: { findFirst: jest.fn().mockResolvedValue(unpaidShipment()) } });
    await expect(again.service.request('driver-1', 'TRK-1', null, 30_000_000)).rejects.toThrow('NGN 260,000');
  });

  it('refuses a price on a paid load, and any price when offers are off', async () => {
    const paid = build({ shipment: { findFirst: jest.fn().mockResolvedValue(unpaidShipment({ status: 'ESCROW_FUNDED', adminApproved: true })) } });
    await expect(paid.service.request('driver-1', 'TRK-1', null, 23_000_000)).rejects.toThrow('before the customer pays');

    const off = build({ shipment: { findFirst: jest.fn().mockResolvedValue(unpaidShipment()) } }, '0');
    await expect(off.service.request('driver-1', 'TRK-1', null, 23_000_000)).rejects.toThrow('does not take price offers');
  });

  it('treats the quoted trip pay as no offer', async () => {
    const query = rawRouter([['insert into "JobRequest"', [{ id: 'req-1' }]]]);
    const { service } = build({ shipment: { findFirst: jest.fn().mockResolvedValue(unpaidShipment()) }, $queryRawUnsafe: query });
    await service.request('driver-1', 'TRK-1', null, 20_000_000);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('insert into "JobRequest"'), expect.any(String), 'ship-1', 'driver-1', 'truck-1', null, null, null, null, null);
  });

  it('accepting a price changes what the customer pays and Trako\'s commission, and holds the load', async () => {
    const shipmentUpdate = jest.fn().mockResolvedValue(undefined);
    const execute = jest.fn().mockResolvedValue(0);
    const query = rawRouter([
      ['from "JobRequest" where "id"', [offer]],
      ['"priceAcceptedAt" is not null limit 1', []],
      ['from "Escrow"', pendingEscrow],
      ['from "ShipmentTimeline"', []],
      ['set "priceAcceptedAt" = current_timestamp', [{ id: 'req-1' }]],
      ['set "status" = \'CLOSED\'', [{ driverId: 'driver-2' }]],
    ]);
    const { service, notify } = build({
      shipment: { findFirst: jest.fn().mockResolvedValue(unpaidShipment()), update: shipmentUpdate },
      $queryRawUnsafe: query,
      $executeRawUnsafe: execute,
    });

    await expect(service.acceptPrice('req-1', 'customer-1', 'CUSTOMER')).resolves.toEqual({ status: 'PRICE_ACCEPTED', quotedPriceKobo: 25_300_000 });
    expect(query).toHaveBeenCalledWith(expect.stringContaining('set "priceAcceptedAt" = current_timestamp'), 'req-1', QUOTE, 2_000_000, 6_000_000, 25_300_000, 2_300_000);
    expect(shipmentUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        quotedPriceKobo: 25_300_000,
        timeline: { create: expect.objectContaining({ note: expect.stringContaining('trip NGN 230,000 + Trako commission NGN 23,000') }) },
      }),
    }));
    expect(execute).toHaveBeenCalledWith(expect.stringContaining('update "Escrow" set "amount" = $2'), 'ship-1', 25_300_000, 2_300_000, 6_000_000);
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ userId: 'driver-1', title: 'Your price was accepted' }));
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ userId: 'driver-2', title: 'Load taken' }));
  });

  it('will not change the price right after a checkout was opened, or once paid', async () => {
    const recent = build({
      shipment: { findFirst: jest.fn().mockResolvedValue(unpaidShipment()) },
      $queryRawUnsafe: rawRouter([
        ['from "JobRequest" where "id"', [offer]],
        ['from "Escrow"', pendingEscrow],
        ['from "ShipmentTimeline"', [{ createdAt: new Date() }]],
      ]),
    });
    await expect(recent.service.acceptPrice('req-1', 'customer-1', 'CUSTOMER')).rejects.toBeInstanceOf(ConflictException);

    const paid = build({
      shipment: { findFirst: jest.fn().mockResolvedValue(unpaidShipment({ status: 'ESCROW_FUNDED' })) },
      $queryRawUnsafe: rawRouter([['from "JobRequest" where "id"', [offer]]]),
    });
    await expect(paid.service.acceptPrice('req-1', 'customer-1', 'CUSTOMER')).rejects.toThrow('already paid');
  });

  it('declining the held driver puts the quote and commission back while unpaid', async () => {
    const held = { ...offer, priceAcceptedAt: new Date(), quoteBeforeKobo: QUOTE, feeBeforeKobo: 2_000_000, driverPayBeforeKobo: 6_000_000 };
    const shipmentUpdate = jest.fn().mockResolvedValue(undefined);
    const execute = jest.fn().mockResolvedValue(0);
    const { service } = build({
      shipment: { findFirst: jest.fn().mockResolvedValue(unpaidShipment({ quotedPriceKobo: 25_300_000 })), update: shipmentUpdate },
      $queryRawUnsafe: rawRouter([
        ['from "JobRequest" where "id"', [held]],
        ['set "status" = \'DECLINED\'', [{ id: 'req-1' }]],
        ['from "Escrow"', [{ ...pendingEscrow[0], amount: 25_300_000 }]],
      ]),
      $executeRawUnsafe: execute,
    });

    await expect(service.decline('req-1', 'customer-1', 'CUSTOMER')).resolves.toEqual({ status: 'DECLINED' });
    expect(shipmentUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ quotedPriceKobo: QUOTE }) }));
    expect(execute).toHaveBeenCalledWith(expect.stringContaining('update "Escrow" set "amount" = $2'), 'ship-1', QUOTE, 2_000_000, 6_000_000);
  });

  it('gives the held driver the load on approval, and lets nobody else be chosen meanwhile', async () => {
    const held = { ...offer, priceAcceptedAt: new Date() };
    const approved = unpaidShipment({ status: 'ESCROW_FUNDED', adminApproved: true, quotedPriceKobo: 25_300_000 });
    const create = jest.fn().mockResolvedValue({ id: 'assignment-1' });
    const { service, notify } = build({
      shipment: { findFirst: jest.fn().mockResolvedValue(approved), update: jest.fn().mockResolvedValue(undefined) },
      driverAssignment: { findFirst: jest.fn().mockResolvedValue(null), create },
      $queryRawUnsafe: rawRouter([
        ['"priceAcceptedAt" is not null limit 1', [held]],
        ['from "JobRequest" where "id"', [{ ...offer, id: 'req-2', driverId: 'driver-2' }]],
        ['set "status" = \'APPROVED\'', [{ id: 'req-1' }]],
      ]),
    });

    await expect(service.approve('req-2', 'customer-1', 'CUSTOMER')).rejects.toThrow('accepted another driver');
    await expect(service.assignReserved('ship-1')).resolves.toBe(true);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ driverId: 'driver-1', status: 'ACCEPTED' }) }));
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ userId: 'customer-1', title: 'Driver confirmed' }));
  });

  it('is hooked to admin approval', () => {
    const { shipments } = build({});
    expect(typeof (shipments as unknown as { assignReservedDriver?: unknown }).assignReservedDriver).toBe('function');
  });

  it('shows drivers the allowed range on unpaid loads and hides loads held for someone else', async () => {
    const { service } = build({
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'driver-1', role: 'DRIVER', isActive: true, verificationStatus: 'VERIFIED', email: 'driver@example.com',
          driverVehicles: [{ id: 'truck-1', capacityKg: 5000, capacityM3: 30, documents: [] }],
        }),
      },
      shipment: { findMany: jest.fn().mockResolvedValue([unpaidShipment(), unpaidShipment({ id: 'ship-2', reference: 'TRK-2' })]) },
      $queryRawUnsafe: rawRouter([
        ['"priceAcceptedAt" is not null', [{ ...offer, shipmentId: 'ship-2', driverId: 'driver-9', priceAcceptedAt: new Date() }]],
      ]),
    });

    const board = await service.listForDriver('driver-1');
    expect(board.loads.map((load) => load.shipmentId)).toEqual(['TRK-1']);
    expect(board.loads[0].priceProposal).toEqual({
      quotedCarrierKobo: 20_000_000, runningCostKobo: 17_000_000, commissionRate: 0.1, minCarrierKobo: 17_000_000, maxCarrierKobo: 26_000_000,
    });
  });
});

