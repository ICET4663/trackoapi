import { ForbiddenException, NotFoundException } from "@nestjs/common";
import type { ConfigService } from "@nestjs/config";
import { CommunicationService } from "./communication.service";
import type { TranslationProviderService } from "../integrations/translation-provider.service";
import type { PrismaService } from "../prisma/prisma.service";
import type { NotificationsService } from "../notifications/notifications.service";
import type { AuthUser } from "../common/types/auth-user";

// Threads with no customer and no driver were readable by every signed-in account, and
// any account could create one just by opening an unused id. Admin "Message driver" /
// "Message user" threads were created that way, so the person never saw them.
// (Security audit 13 October, open risk.)
describe("CommunicationService conversation scope", () => {
  const admin = { sub: "admin-1", email: "a@x", role: "ADMIN" } as AuthUser;
  const customer = { sub: "customer-1", email: "c@x", role: "CUSTOMER" } as AuthUser;
  const driver = { sub: "driver-1", email: "d@x", role: "DRIVER" } as AuthUser;

  function build(existing: Record<string, unknown> | null, recipientRole: string | null = null) {
    const upsert = jest.fn((args: { create: Record<string, unknown>; update: Record<string, unknown> }) =>
      Promise.resolve({ shipmentId: null, customerId: null, driverId: null, ...(existing ?? args.create), ...(existing ? args.update : {}) }));
    const prisma = {
      conversation: {
        findUnique: jest.fn().mockResolvedValue(existing),
        upsert,
        update: jest.fn().mockResolvedValue(existing),
      },
      user: { findUnique: jest.fn().mockResolvedValue(recipientRole ? { role: recipientRole } : null) },
      message: { findMany: jest.fn().mockResolvedValue([]), updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      driverAssignment: { findFirst: jest.fn().mockResolvedValue(null) },
    } as unknown as PrismaService;
    const service = new CommunicationService(
      { get: jest.fn() } as unknown as ConfigService,
      prisma,
      {} as NotificationsService,
      { translate: jest.fn(), transcribe: jest.fn(), status: jest.fn() } as unknown as TranslationProviderService,
    );
    return { service, upsert };
  }

  it("a customer cannot create a thread by opening an unused id", async () => {
    const { service, upsert } = build(null);

    await expect(service.listMessages("made-up-id", customer)).rejects.toBeInstanceOf(NotFoundException);
    expect(upsert).not.toHaveBeenCalled();
  });

  it("a customer cannot read an old thread that has no customer or driver", async () => {
    const { service } = build({ id: "old-thread", shipmentId: null, customerId: null, driverId: null });

    await expect(service.listMessages("old-thread", customer)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("an admin messaging a driver creates a thread addressed to that driver, who can then read it", async () => {
    const { service, upsert } = build(null, "DRIVER");

    await service.listMessages("driver-1", admin);
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ create: expect.objectContaining({ id: "driver-1", driverId: "driver-1" }) }));

    const addressed = build({ id: "driver-1", shipmentId: null, customerId: null, driverId: "driver-1" });
    await expect(addressed.service.listMessages("driver-1", driver)).resolves.toMatchObject({ messages: [] });
  });

  it("an admin messaging a customer addresses the thread to the customer", async () => {
    const { service, upsert } = build(null, "CUSTOMER");

    await service.listMessages("customer-1", admin);
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ create: expect.objectContaining({ customerId: "customer-1" }) }));
  });

  it("an existing unaddressed admin thread is addressed to its person the next time staff open it", async () => {
    const { service, upsert } = build({ id: "driver-1", shipmentId: null, customerId: null, driverId: null }, "DRIVER");

    await service.listMessages("driver-1", admin);
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ update: expect.objectContaining({ driverId: "driver-1" }) }));
  });

  it("staff can still open an unaddressed thread that is not a person's id", async () => {
    const { service } = build({ id: "ops-room", shipmentId: null, customerId: null, driverId: null });

    await expect(service.listMessages("ops-room", admin)).resolves.toMatchObject({ messages: [] });
  });
});
