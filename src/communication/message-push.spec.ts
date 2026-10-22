import { ConfigService } from "@nestjs/config";
import { CommunicationService } from "./communication.service";
import type { TranslationProviderService } from "../integrations/translation-provider.service";
import type { PrismaService } from "../prisma/prisma.service";
import type { NotificationsService } from "../notifications/notifications.service";
import type { AuthUser } from "../common/types/auth-user";

const customer = { sub: "customer-1", email: "c@x.com", role: "CUSTOMER" } as AuthUser;
const dispatcher = { sub: "dispatcher-1", email: "d@x.com", role: "DISPATCHER" } as AuthUser;

function savedMessage(overrides: Record<string, unknown> = {}) {
  return {
    id: "msg-1",
    conversationId: "conv-1",
    senderId: "customer-1",
    kind: "TEXT",
    body: "Gate 3, ask for Bola",
    attachmentUrl: null,
    transcript: null,
    durationSeconds: null,
    translatedText: null,
    translatedLanguage: null,
    sourceLanguage: null,
    deliveryStatus: "SENT",
    readAt: null,
    createdAt: new Date(),
    sender: { role: "CUSTOMER", profile: { fullName: "Ada Obi" } },
    ...overrides,
  };
}

function build(message = savedMessage(), conversation = { id: "conv-1", customerId: "customer-1", driverId: "driver-1" }) {
  const users: Record<string, string> = { "customer-1": "CUSTOMER", "driver-1": "DRIVER" };
  const prisma = {
    conversation: {
      findUnique: jest.fn().mockResolvedValue(conversation),
      update: jest.fn().mockResolvedValue(conversation),
    },
    message: { create: jest.fn().mockResolvedValue(message) },
    user: {
      findUnique: jest.fn().mockResolvedValue({ preferredLanguage: "en" }),
      findMany: jest.fn(({ where }: { where: { id: { in: string[] } } }) =>
        Promise.resolve(where.id.in.map((id) => ({ id, role: users[id] })))),
    },
  } as unknown as PrismaService;
  const pushOnly = jest.fn().mockResolvedValue(undefined);
  const service = new CommunicationService(
    {} as ConfigService,
    prisma,
    { pushOnly } as unknown as NotificationsService,
    { translate: jest.fn().mockResolvedValue(null) } as unknown as TranslationProviderService,
  );
  return { service, pushOnly, prisma };
}

describe("new message push", () => {
  it("pushes the other participant on the messages channel and opens their conversation", async () => {
    const { service, pushOnly } = build();

    await service.sendMessage("conv-1", "customer-1", { kind: "TEXT", body: "Gate 3, ask for Bola" } as never, customer);

    expect(pushOnly).toHaveBeenCalledTimes(1);
    expect(pushOnly).toHaveBeenCalledWith({
      userId: "driver-1",
      title: "Ada Obi",
      body: "Gate 3, ask for Bola",
      entity: "Conversation",
      entityId: "conv-1",
      actionUrl: "/driver/messages/conv-1",
      channelId: "messages",
    });
  });

  it("pushes both customer and driver when operations write, under the Trako name", async () => {
    const { service, pushOnly } = build(savedMessage({ senderId: "dispatcher-1", sender: { role: "DISPATCHER", profile: { fullName: "Femi" } } }));

    await service.sendMessage("conv-1", "dispatcher-1", { kind: "TEXT", body: "Driver is 10 minutes away" } as never, dispatcher);

    expect(pushOnly.mock.calls.map(([input]) => [input.userId, input.actionUrl, input.title])).toEqual([
      ["customer-1", "/customer/messages/conv-1", "Trako operations"],
      ["driver-1", "/driver/messages/conv-1", "Trako operations"],
    ]);
  });

  it("describes voice notes and attachments instead of sending their content", async () => {
    const voice = build(savedMessage({ kind: "VOICE", body: null }));
    await voice.service.sendMessage("conv-1", "customer-1", { kind: "VOICE" } as never, customer);
    expect(voice.pushOnly.mock.calls[0][0].body).toBe("Voice note");

    const photo = build(savedMessage({ kind: "ATTACHMENT", body: null }));
    await photo.service.sendMessage("conv-1", "customer-1", { kind: "ATTACHMENT" } as never, customer);
    expect(photo.pushOnly.mock.calls[0][0].body).toBe("Sent an attachment");
  });

  it("shortens long text to a preview", async () => {
    const long = "x".repeat(300);
    const { service, pushOnly } = build(savedMessage({ body: long }));

    await service.sendMessage("conv-1", "customer-1", { kind: "TEXT", body: long } as never, customer);

    expect(pushOnly.mock.calls[0][0].body).toHaveLength(140);
  });

  it("pushes nobody before a driver joins the conversation", async () => {
    const { service, pushOnly } = build(savedMessage(), { id: "conv-1", customerId: "customer-1", driverId: null as never });

    await service.sendMessage("conv-1", "customer-1", { kind: "TEXT", body: "hello" } as never, customer);

    expect(pushOnly).not.toHaveBeenCalled();
  });

  it("still returns the saved message when the push fails", async () => {
    const { service, pushOnly } = build();
    pushOnly.mockRejectedValue(new Error("expo down"));

    const result = await service.sendMessage("conv-1", "customer-1", { kind: "TEXT", body: "hello" } as never, customer);

    expect(result.id).toBe("msg-1");
  });
});
