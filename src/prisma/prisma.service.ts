import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService implements OnModuleDestroy {
  private client?: PrismaClient;

  private get db() {
    this.client ??= new PrismaClient();
    return this.client;
  }

  get auditLog() {
    return this.db.auditLog;
  }

  get bankAccount() {
    return this.db.bankAccount;
  }

  get conversation() {
    return this.db.conversation;
  }

  get rateLimitBucket() {
    return this.db.rateLimitBucket;
  }

  get driverAssignment() {
    return this.db.driverAssignment;
  }

  get message() {
    return this.db.message;
  }

  get otpCode() {
    return this.db.otpCode;
  }

  get payout() {
    return this.db.payout;
  }

  get platformSetting() {
    return this.db.platformSetting;
  }

  get paymentMethod() {
    return this.db.paymentMethod;
  }

  get profile() {
    return this.db.profile;
  }

  get refreshToken() {
    return this.db.refreshToken;
  }

  get review() {
    return this.db.review;
  }

  get shipment() {
    return this.db.shipment;
  }

  get user() {
    return this.db.user;
  }

  get vehicle() {
    return this.db.vehicle;
  }

  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]) {
    return this.db.$queryRawUnsafe<T>(query, ...values);
  }

  $executeRawUnsafe(query: string, ...values: unknown[]) {
    return this.db.$executeRawUnsafe(query, ...values);
  }

  $transaction(input: unknown) {
    return this.db.$transaction(input as never);
  }

  async onModuleDestroy() {
    await this.client?.$disconnect();
  }
}

