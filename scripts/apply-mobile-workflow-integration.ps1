param(
  [string]$AppPath = "C:\Users\hp\Downloads\CargoLink-Logistics-main (6)\CargoLink-Logistics-main"
)

$ErrorActionPreference = "Stop"

$typesPath = Join-Path $AppPath "src\types\backend.ts"
$servicePath = Join-Path $AppPath "src\services\shipment-service.ts"
$operationsServicePath = Join-Path $AppPath "src\services\operations-service.ts"
$trackingServicePath = Join-Path $AppPath "src\services\tracking-service.ts"
$notificationsServicePath = Join-Path $AppPath "src\services\notifications-service.ts"

if (!(Test-Path $typesPath)) {
  throw "Cannot find backend types file at $typesPath"
}

if (!(Test-Path $servicePath)) {
  throw "Cannot find shipment service file at $servicePath"
}

$types = Get-Content $typesPath -Raw
if ($types -notmatch "DriverAssignmentRecord") {
  $types += @'

export type DriverAssignmentStatus = 'OFFERED' | 'ACCEPTED' | 'REJECTED' | 'EXPIRED' | 'CANCELLED';

export type AvailableDriverRecord = {
  id: BackendID;
  fullName: string;
  email: string;
  phone: string;
  verificationStatus: VerificationStatus;
  vehicles: {
    id: BackendID;
    plateNumber: string;
    type: string;
    capacityKg?: number;
  }[];
};

export type DriverAssignmentRecord = {
  id: BackendID;
  shipmentId: BackendID;
  driverId: BackendID;
  vehicleId?: BackendID;
  status: DriverAssignmentStatus;
  offeredAt: string;
  acceptedAt?: string;
  rejectedAt?: string;
  driver?: {
    id: BackendID;
    fullName: string;
    email: string;
    phone: string;
  };
  vehicle?: {
    id: BackendID;
    plateNumber: string;
    type: string;
    capacityKg?: number;
  };
  shipment?: ShipmentRecord;
};

export type IntegrationStatusRecord = {
  kyc: {
    provider: string;
    mode: 'mock' | 'configured';
    realVerificationEnabled: boolean;
    requiredEnv: string[];
  };
  payments: {
    provider: string;
    mode: 'mock' | 'configured';
    escrowEnabled: boolean;
    realChargeEnabled: boolean;
    requiredEnv: string[];
  };
  maps: {
    provider: string;
    mode: 'mock' | 'configured';
    realRoutingEnabled: boolean;
    requiredEnv: string[];
  };
};

export type ShipmentLocationPing = {
  id: BackendID;
  shipmentId: BackendID;
  driverId?: BackendID;
  latitude: number;
  longitude: number;
  heading?: number;
  speedKph?: number;
  note?: string;
  createdAt: string;
};

export type DeliveryProofRecord = {
  id: BackendID;
  shipmentId: BackendID;
  driverId?: BackendID;
  photoUrl?: string;
  signatureUrl?: string;
  recipientName?: string;
  note?: string;
  status: 'SUBMITTED' | 'APPROVED' | 'REJECTED';
  submittedAt: string;
};

export type NotificationRecord = {
  id: BackendID;
  userId?: BackendID;
  role?: UserRole;
  title: string;
  body: string;
  tone: 'INFO' | 'SUCCESS' | 'WARNING' | 'DANGER';
  entity?: string;
  entityId?: string;
  actionUrl?: string;
  readAt?: string;
  createdAt: string;
};
'@
  Set-Content $typesPath $types
}

@'
import { apiRequest } from '@/src/services/api-client';
import type {
  AvailableDriverRecord,
  BackendID,
  CreateShipmentInput,
  DriverAssignmentRecord,
  EscrowRecord,
  IntegrationStatusRecord,
  ShipmentRecord,
  ShipmentTimelineEvent,
} from '@/src/types/backend';
import type { ShipmentStatus } from '@/src/constants/shipment-status';

export const shipmentService = {
  async createShipment(input: CreateShipmentInput, accessToken?: string): Promise<ShipmentRecord> {
    return apiRequest<ShipmentRecord>('/v1/shipments', { method: 'POST', body: input, accessToken });
  },

  async listShipments(accessToken?: string, role?: string): Promise<ShipmentRecord[]> {
    const query = role ? `?role=${encodeURIComponent(role)}` : '';
    return apiRequest<ShipmentRecord[]>(`/v1/shipments${query}`, { accessToken });
  },

  async getShipment(shipmentId: BackendID, accessToken?: string, role?: string): Promise<ShipmentRecord> {
    const query = role ? `?role=${encodeURIComponent(role)}` : '';
    return apiRequest<ShipmentRecord>(`/v1/shipments/${encodeURIComponent(shipmentId)}${query}`, { accessToken });
  },

  async updateShipmentStatus(
    shipmentId: BackendID,
    status: ShipmentStatus,
    note?: string,
    accessToken?: string,
  ): Promise<ShipmentRecord> {
    return apiRequest<ShipmentRecord>(`/v1/shipments/${encodeURIComponent(shipmentId)}/status`, {
      method: 'PATCH',
      body: { status, note },
      accessToken,
    });
  },

  async addTimelineEvent(
    shipmentId: BackendID,
    event: Omit<ShipmentTimelineEvent, 'id' | 'createdAt'>,
    accessToken?: string,
  ) {
    return apiRequest<ShipmentTimelineEvent>(`/v1/shipments/${encodeURIComponent(shipmentId)}/timeline`, {
      method: 'POST',
      body: event,
      accessToken,
    });
  },

  async availableDrivers(accessToken?: string): Promise<AvailableDriverRecord[]> {
    return apiRequest<AvailableDriverRecord[]>('/v1/shipments/dispatch/available-drivers', { accessToken });
  },

  async listAssignments(shipmentId: BackendID, accessToken?: string): Promise<DriverAssignmentRecord[]> {
    return apiRequest<DriverAssignmentRecord[]>(`/v1/shipments/${encodeURIComponent(shipmentId)}/assignments`, {
      accessToken,
    });
  },

  async offerAssignment(
    shipmentId: BackendID,
    input: { driverId: BackendID; vehicleId?: BackendID },
    accessToken?: string,
  ): Promise<DriverAssignmentRecord> {
    return apiRequest<DriverAssignmentRecord>(`/v1/shipments/${encodeURIComponent(shipmentId)}/assignments`, {
      method: 'POST',
      body: input,
      accessToken,
    });
  },

  async acceptAssignment(assignmentId: BackendID, accessToken?: string): Promise<DriverAssignmentRecord> {
    return apiRequest<DriverAssignmentRecord>(`/v1/shipments/assignments/${encodeURIComponent(assignmentId)}/accept`, {
      method: 'POST',
      accessToken,
    });
  },

  async rejectAssignment(assignmentId: BackendID, accessToken?: string): Promise<DriverAssignmentRecord> {
    return apiRequest<DriverAssignmentRecord>(`/v1/shipments/assignments/${encodeURIComponent(assignmentId)}/reject`, {
      method: 'POST',
      accessToken,
    });
  },

  async getEscrow(shipmentId: BackendID, accessToken?: string): Promise<EscrowRecord> {
    return apiRequest<EscrowRecord>(`/v1/shipments/${encodeURIComponent(shipmentId)}/escrow`, { accessToken });
  },

  async initializeEscrowPayment(
    input: { shipmentId: BackendID; amount: number; currency?: 'NGN' | 'USD'; customerEmail?: string },
    accessToken?: string,
  ) {
    return apiRequest('/v1/payments/escrow/initialize', { method: 'POST', body: input, accessToken });
  },

  async integrationStatus(): Promise<IntegrationStatusRecord> {
    return apiRequest<IntegrationStatusRecord>('/v1/integrations/status');
  },
};
'@ | Set-Content $servicePath

@'
import { apiRequest } from '@/src/services/api-client';
import type { BackendID } from '@/src/types/backend';
import type { ShipmentStatus } from '@/src/constants/shipment-status';

export type OperationsDashboard = {
  metrics: {
    activeShipments: number;
    openOffers: number;
    activeDrivers: number;
    pendingVerifications: number;
  };
  recentShipments: {
    id: BackendID;
    reference: string;
    origin: string;
    destination: string;
    status: string;
    cargo: string;
    createdAt: string;
  }[];
  assignmentQueue: {
    id: BackendID;
    shipmentId: BackendID;
    driverId: BackendID;
    vehicleId?: BackendID;
    status: string;
    offeredAt: string;
  }[];
};

export const operationsService = {
  dashboard(accessToken?: string) {
    return apiRequest<OperationsDashboard>('/v1/operations/dashboard', { accessToken });
  },

  progressShipment(
    shipmentId: BackendID,
    input: { status: ShipmentStatus; note?: string; location?: string },
    accessToken?: string,
  ) {
    return apiRequest(`/v1/operations/shipments/${encodeURIComponent(shipmentId)}/progress`, {
      method: 'POST',
      body: input,
      accessToken,
    });
  },

  createDispute(input: { shipmentId?: BackendID; reason: string; priority?: string; description?: string }, accessToken?: string) {
    return apiRequest('/v1/operations/disputes', { method: 'POST', body: input, accessToken });
  },

  resolveDispute(disputeId: BackendID, input: { shipmentId?: BackendID; resolution?: string }, accessToken?: string) {
    return apiRequest(`/v1/operations/disputes/${encodeURIComponent(disputeId)}/resolve`, {
      method: 'PATCH',
      body: input,
      accessToken,
    });
  },

  createSupportTicket(
    input: { topic?: string; channel?: string; message?: string; shipmentId?: BackendID },
    accessToken?: string,
  ) {
    return apiRequest('/v1/operations/support/tickets', { method: 'POST', body: input, accessToken });
  },
};
'@ | Set-Content $operationsServicePath

@'
import { apiRequest } from '@/src/services/api-client';
import type { BackendID, DeliveryProofRecord, ShipmentLocationPing } from '@/src/types/backend';

export const trackingService = {
  currentLocation(shipmentId: BackendID, accessToken?: string) {
    return apiRequest<ShipmentLocationPing>(`/v1/tracking/shipments/${encodeURIComponent(shipmentId)}`, { accessToken });
  },

  locationHistory(shipmentId: BackendID, accessToken?: string) {
    return apiRequest<ShipmentLocationPing[]>(`/v1/tracking/shipments/${encodeURIComponent(shipmentId)}/history`, {
      accessToken,
    });
  },

  recordLocation(
    shipmentId: BackendID,
    input: { latitude: number; longitude: number; heading?: number; speedKph?: number; note?: string },
    accessToken?: string,
  ) {
    return apiRequest<ShipmentLocationPing>(`/v1/tracking/shipments/${encodeURIComponent(shipmentId)}/location`, {
      method: 'POST',
      body: input,
      accessToken,
    });
  },

  deliveryProofs(shipmentId: BackendID, accessToken?: string) {
    return apiRequest<DeliveryProofRecord[]>(`/v1/tracking/shipments/${encodeURIComponent(shipmentId)}/proof-of-delivery`, {
      accessToken,
    });
  },

  submitDeliveryProof(
    shipmentId: BackendID,
    input: { photoUrl?: string; signatureUrl?: string; recipientName?: string; note?: string },
    accessToken?: string,
  ) {
    return apiRequest<DeliveryProofRecord>(`/v1/tracking/shipments/${encodeURIComponent(shipmentId)}/proof-of-delivery`, {
      method: 'POST',
      body: input,
      accessToken,
    });
  },
};
'@ | Set-Content $trackingServicePath

@'
import { apiRequest } from '@/src/services/api-client';
import type { BackendID, NotificationRecord } from '@/src/types/backend';

export const notificationsService = {
  list(accessToken?: string) {
    return apiRequest<NotificationRecord[]>('/v1/notifications', { accessToken });
  },

  unreadCount(accessToken?: string) {
    return apiRequest<{ unreadCount: number }>('/v1/notifications/unread-count', { accessToken });
  },

  markRead(notificationId: BackendID, accessToken?: string) {
    return apiRequest<NotificationRecord>(`/v1/notifications/${encodeURIComponent(notificationId)}/read`, {
      method: 'PATCH',
      accessToken,
    });
  },

  markAllRead(accessToken?: string) {
    return apiRequest<{ markedRead: boolean; updatedAt: string }>('/v1/notifications/mark-all-read', {
      method: 'POST',
      accessToken,
    });
  },

  registerPushToken(input: { token: string; platform?: string; deviceId?: string }, accessToken?: string) {
    return apiRequest('/v1/notifications/push-token', { method: 'POST', body: input, accessToken });
  },
};
'@ | Set-Content $notificationsServicePath

Write-Host "Mobile workflow integration applied to $AppPath"
