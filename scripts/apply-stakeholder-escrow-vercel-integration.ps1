param(
  [string]$AppPath = "C:\Users\hp\Downloads\CargoLink-Logistics-main (6)\CargoLink-Logistics-main",
  [string]$BackendUrl = ""
)

$ErrorActionPreference = "Stop"

if (!(Test-Path (Join-Path $AppPath "package.json"))) {
  throw "Cannot find package.json in $AppPath. Pass -AppPath with the real Expo app folder."
}

function Write-Utf8File([string]$Path, [string]$Content) {
  $directory = Split-Path -Parent $Path
  if (!(Test-Path $directory)) {
    New-Item -ItemType Directory -Path $directory | Out-Null
  }
  $utf8 = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($Path, $Content, $utf8)
}

Write-Utf8File (Join-Path $AppPath "src\services\escrow-service.ts") @'
import { apiRequest } from '@/src/services/api-client';
import type { EscrowRecord } from '@/src/types/backend';

type InitializeEscrowInput = {
  shipmentId: string;
  amount: number;
  currency?: 'NGN' | 'USD';
  customerEmail?: string;
};

type EscrowPaymentInitialization = {
  provider: string;
  providerReference: string;
  authorizationUrl?: string;
  accessCode?: string;
  status: 'mock' | 'initialized';
  message: string;
};

export const escrowService = {
  async getEscrow(shipmentId: string, accessToken?: string): Promise<EscrowRecord> {
    return apiRequest<EscrowRecord>(`/v1/shipments/${encodeURIComponent(shipmentId)}/escrow`, { accessToken });
  },

  async initializePayment(input: InitializeEscrowInput, accessToken?: string): Promise<EscrowPaymentInitialization> {
    return apiRequest<EscrowPaymentInitialization>('/v1/payments/escrow/initialize', {
      method: 'POST',
      body: input,
      accessToken,
    });
  },

  async confirmReleaseCheck(shipmentId: string, check: keyof EscrowRecord['releaseChecks'], accessToken?: string) {
    return apiRequest<EscrowRecord>(`/v1/shipments/${encodeURIComponent(shipmentId)}/escrow/checks/${check}`, { method: 'POST', accessToken });
  },

  async release(shipmentId: string, note?: string, accessToken?: string): Promise<EscrowRecord> {
    return apiRequest<EscrowRecord>(`/v1/shipments/${encodeURIComponent(shipmentId)}/escrow/release`, {
      method: 'POST',
      body: { note },
      accessToken,
    });
  },

  async dispute(shipmentId: string, reason: string, accessToken?: string): Promise<EscrowRecord> {
    return apiRequest<EscrowRecord>(`/v1/shipments/${encodeURIComponent(shipmentId)}/escrow/dispute`, {
      method: 'POST',
      body: { reason },
      accessToken,
    });
  },

  async refund(shipmentId: string, reason: string, accessToken?: string): Promise<EscrowRecord> {
    return apiRequest<EscrowRecord>(`/v1/shipments/${encodeURIComponent(shipmentId)}/escrow/refund`, {
      method: 'POST',
      body: { reason },
      accessToken,
    });
  },
};
'@

Write-Utf8File (Join-Path $AppPath "app\(admin)\admin\(tabs)\finance.tsx") @'
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { AppText } from '@/src/components/common/AppText';
import { ScreenContainer } from '@/src/components/common/ScreenContainer';
import { notify } from '@/src/lib/notify';
import { escrowService } from '@/src/services/escrow-service';
import { useAuth } from '@/src/store/auth-context';
import { radius, spacing, useThemeColors, type ThemeColors } from '@/src/theme';

type LedgerItem = {
  id: string;
  route: string;
  amount: string;
  status: 'Held' | 'Disputed' | 'Released';
};

const LEDGER: LedgerItem[] = [
  { id: 'TRK-20418', route: 'Kano to Abuja', amount: 'NGN 350,500', status: 'Held' },
  { id: 'TRK-20392', route: 'Port Harcourt to Enugu', amount: 'NGN 410,000', status: 'Disputed' },
  { id: 'TRK-20402', route: 'Kaduna to Lagos', amount: 'NGN 442,000', status: 'Held' },
];

const RELEASE_CHECKS = [
  'arrivalConfirmed',
  'proofOfDeliveryUploaded',
  'customerDeliveryConfirmed',
  'disputeWindowClear',
  'platformApproved',
] as const;

export default function Finance() {
  const colors = useThemeColors();
  const styles = makeStyles(colors);
  const { session } = useAuth();
  const [busyAction, setBusyAction] = useState<string | null>(null);

  async function releaseFunds(shipmentId: string) {
    const key = `release:${shipmentId}`;
    if (busyAction) return;
    setBusyAction(key);
    try {
      for (const check of RELEASE_CHECKS) {
        await escrowService.confirmReleaseCheck(shipmentId, check, session?.accessToken);
      }
      await escrowService.release(shipmentId, 'Admin approved escrow release after delivery checks passed.', session?.accessToken);
      notify('Escrow released', `${shipmentId} is now marked for driver payout.`);
    } catch (error) {
      notify('Release failed', error instanceof Error ? error.message : 'Please try again.');
    } finally {
      setBusyAction(null);
    }
  }

  async function refundCustomer(shipmentId: string) {
    const key = `refund:${shipmentId}`;
    if (busyAction) return;
    setBusyAction(key);
    try {
      await escrowService.refund(shipmentId, 'Admin refunded escrow after finance review.', session?.accessToken);
      notify('Escrow refunded', `${shipmentId} refund has been recorded.`);
    } catch (error) {
      notify('Refund failed', error instanceof Error ? error.message : 'Please try again.');
    } finally {
      setBusyAction(null);
    }
  }

  return (
    <ScreenContainer contentStyle={styles.content}>
      <View>
        <AppText variant="display" weight="extrabold">Escrow</AppText>
        <AppText color={colors.secondary}>Finance controls for release, dispute review, and refunds.</AppText>
      </View>
      <View style={styles.total}>
        <AppText variant="caption" color="#FFFFFFB8">TOTAL HELD</AppText>
        <AppText variant="display" weight="extrabold" color={colors.onDark}>NGN 284M</AppText>
        <AppText variant="caption" color="#93D6FF">Across 612 active shipments</AppText>
      </View>
      <View style={styles.filters}>
        {['Held', 'Disputed', 'Released'].map((item, index) => (
          <View key={item} style={[styles.filter, index === 0 && styles.active]}>
            <AppText variant="caption" weight="bold" color={index === 0 ? colors.primaryText : colors.navy}>{item}</AppText>
          </View>
        ))}
      </View>
      {LEDGER.map((item) => (
        <Ledger
          key={item.id}
          item={item}
          releasing={busyAction === `release:${item.id}`}
          refunding={busyAction === `refund:${item.id}`}
          disabled={Boolean(busyAction)}
          onRelease={() => void releaseFunds(item.id)}
          onRefund={() => void refundCustomer(item.id)}
        />
      ))}
    </ScreenContainer>
  );
}

function Ledger({
  item,
  releasing,
  refunding,
  disabled,
  onRelease,
  onRefund,
}: {
  item: LedgerItem;
  releasing: boolean;
  refunding: boolean;
  disabled: boolean;
  onRelease: () => void;
  onRefund: () => void;
}) {
  const colors = useThemeColors();
  const styles = makeStyles(colors);
  const tone = item.status === 'Disputed' ? colors.status.error : item.status === 'Released' ? colors.status.completed : colors.status.success;

  return (
    <View style={styles.ledger}>
      <View style={styles.top}>
        <AppText variant="caption" color={colors.secondary}>{item.id}</AppText>
        <AppText variant="caption" weight="bold" color={tone}>{item.status}</AppText>
      </View>
      <AppText weight="extrabold">{item.route}</AppText>
      <AppText variant="sectionTitle" weight="extrabold">{item.amount}</AppText>
      <View style={styles.actions}>
        <Pressable accessibilityRole="button" disabled={disabled} onPress={onRefund} style={[styles.secondary, disabled && styles.disabled]}>
          <MaterialIcons name="undo" size={17} color={colors.navy} />
          <AppText variant="caption" weight="bold">{refunding ? 'Refunding...' : 'Refund'}</AppText>
        </Pressable>
        <Pressable accessibilityRole="button" disabled={disabled} onPress={onRelease} style={[styles.primary, disabled && styles.disabled]}>
          <MaterialIcons name="payments" size={17} color={colors.primaryText} />
          <AppText variant="caption" weight="bold" color={colors.primaryText}>{releasing ? 'Releasing...' : 'Release funds'}</AppText>
        </Pressable>
      </View>
    </View>
  );
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  content: { paddingBottom: spacing.xxl },
  total: { borderRadius: radius.xl, backgroundColor: colors.inverse, padding: spacing.lg },
  filters: { flexDirection: 'row', gap: spacing.xs },
  filter: { minHeight: 38, borderRadius: radius.round, borderWidth: 1, borderColor: colors.border, paddingHorizontal: spacing.md, alignItems: 'center', justifyContent: 'center' },
  active: { backgroundColor: colors.primary, borderColor: colors.primary },
  ledger: { borderRadius: radius.lg, backgroundColor: colors.white, borderWidth: 1, borderColor: colors.border, padding: spacing.md, gap: 4 },
  top: { flexDirection: 'row', justifyContent: 'space-between' },
  actions: { flexDirection: 'row', gap: spacing.xs, marginTop: spacing.xs },
  secondary: { flex: 1, minHeight: 40, borderRadius: radius.sm, borderWidth: 1, borderColor: colors.border, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: spacing.xs },
  primary: { flex: 1, minHeight: 40, borderRadius: radius.sm, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: spacing.xs },
  disabled: { opacity: 0.55 },
});
'@

Write-Utf8File (Join-Path $AppPath "app\(dispatcher)\dispatcher\dispute\[id].tsx") @'
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { AppText } from '@/src/components/common/AppText';
import { AsyncBoundary } from '@/src/components/common/AsyncBoundary';
import { ScreenContainer } from '@/src/components/common/ScreenContainer';
import type { DispatcherDispute } from '@/src/data/dispatcher-operations';
import { useApiItem } from '@/src/hooks/use-api-data';
import { confirmAction, notify } from '@/src/lib/notify';
import { escrowService } from '@/src/services/escrow-service';
import { useAuth } from '@/src/store/auth-context';
import { radius, spacing, useThemeColors, type ThemeColors } from '@/src/theme';

const RELEASE_CHECKS = [
  'arrivalConfirmed',
  'proofOfDeliveryUploaded',
  'customerDeliveryConfirmed',
  'disputeWindowClear',
  'platformApproved',
] as const;

export default function DisputeDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data: dispute, status: loadStatus, refetch } = useApiItem<DispatcherDispute>('dispatcher-disputes', id);
  const colors = useThemeColors();
  const styles = makeStyles(colors);
  const { session } = useAuth();
  const [busyDecision, setBusyDecision] = useState<'refund' | 'release' | null>(null);

  async function resolveEscrow(decision: 'Refund customer' | 'Release to driver') {
    if (!dispute || busyDecision) return;
    const action = decision === 'Refund customer' ? 'refund' : 'release';
    setBusyDecision(action);
    try {
      if (decision === 'Refund customer') {
        await escrowService.refund(dispute.shipmentId, `Dispatcher resolved ${dispute.id} with customer refund.`, session?.accessToken);
      } else {
        for (const check of RELEASE_CHECKS) {
          await escrowService.confirmReleaseCheck(dispute.shipmentId, check, session?.accessToken);
        }
        await escrowService.release(dispute.shipmentId, `Dispatcher resolved ${dispute.id} and released funds to driver.`, session?.accessToken);
      }
      notify('Decision recorded', `${decision} was recorded for ${dispute.shipmentId}.`);
      refetch();
    } catch (error) {
      notify('Decision failed', error instanceof Error ? error.message : 'Please try again.');
    } finally {
      setBusyDecision(null);
    }
  }

  const decide = (decision: 'Refund customer' | 'Release to driver') => {
    if (!dispute) return;
    confirmAction(
      decision,
      `${decision} for ${dispute.shipmentId}? This records the dispatcher decision and updates escrow.`,
      'Confirm decision',
      () => void resolveEscrow(decision),
      decision === 'Refund customer',
    );
  };

  return <ScreenContainer contentStyle={styles.content}>
    <View style={styles.header}><Pressable accessibilityRole="button" accessibilityLabel="Go back" onPress={() => router.back()}><MaterialIcons name="arrow-back" size={24} color={colors.navy} /></Pressable><AppText variant="caption" weight="bold" color={colors.secondary}>{dispute?.id}</AppText></View>
    <AsyncBoundary status={loadStatus} onRetry={refetch} loadingLabel="Loading dispute..." errorLabel="Couldn't load this dispute.">
    {dispute ? <>
    <View style={styles.badges}><View style={styles.open}><AppText variant="caption" weight="bold" color={colors.status.error}>{dispute.status}</AppText></View><View style={styles.category}><AppText variant="caption" weight="bold" color={colors.status.warning}>{dispute.category}</AppText></View></View>
    <View><AppText variant="title" weight="extrabold">{dispute.title}</AppText><AppText color={colors.secondary}>Shipment {dispute.shipmentId} - {dispute.summary}</AppText></View>
    <View style={styles.shipmentLink}><View style={styles.fill}><AppText variant="caption" color={colors.secondary}>Linked shipment</AppText><AppText weight="extrabold">{dispute.shipmentId}</AppText></View><Pressable accessibilityRole="button" onPress={() => router.push({ pathname: '/dispatcher/shipment/[id]', params: { id: dispute.shipmentId } })}><AppText variant="caption" weight="bold" color={colors.primaryStrong}>View shipment</AppText></Pressable></View>
    <AppText variant="input" weight="extrabold">Evidence</AppText><View style={styles.evidence}><Evidence kind="photo" label="Customer photo" color="#8D7655" /><Evidence kind="photo" label="Driver photo" color="#71899E" /><Evidence kind="mic" label="Voice" /><Evidence kind="description" label="POD" /></View>
    <AppText variant="input" weight="extrabold">Timeline</AppText><View style={styles.timeline}><TimelineItem title="Customer opened dispute" time="14:48, 22 Jun" /><TimelineItem title="Driver responded with photos" time="15:10, 22 Jun" /><TimelineItem title="Awaiting dispatcher review" active /></View>
    <Pressable accessibilityRole="button" onPress={() => notify('Internal note', 'Internal note entry is ready for backend persistence.')} style={styles.note}><MaterialIcons name="note-add" size={19} color={colors.primaryStrong} /><AppText weight="bold">Add internal note</AppText></Pressable>
    {dispute.status !== 'Resolved' ? <View style={styles.actions}><Pressable accessibilityRole="button" disabled={Boolean(busyDecision)} onPress={() => decide('Refund customer')} style={[styles.secondary, busyDecision && styles.disabled]}><AppText weight="bold">{busyDecision === 'refund' ? 'Refunding...' : 'Refund customer'}</AppText></Pressable><Pressable accessibilityRole="button" disabled={Boolean(busyDecision)} onPress={() => decide('Release to driver')} style={[styles.primary, busyDecision && styles.disabled]}><AppText weight="bold" color={colors.primaryText}>{busyDecision === 'release' ? 'Releasing...' : 'Release to driver'}</AppText></Pressable></View> : null}
    </> : null}
    </AsyncBoundary>
  </ScreenContainer>;
}

function Evidence({ kind, label, color }: { kind: 'photo' | 'mic' | 'description'; label: string; color?: string }) { const colors = useThemeColors(); const styles = makeStyles(colors); return <Pressable accessibilityRole="button" accessibilityLabel={`Open ${label}`} onPress={() => notify(label, kind === 'photo' ? 'Evidence image preview.' : 'Evidence attachment preview.')} style={[styles.evidenceItem, color ? { backgroundColor: color } : null]}>{kind !== 'photo' ? <MaterialIcons name={kind} size={20} color={colors.secondary} /> : <MaterialIcons name="image" size={20} color={colors.onDark} />}<AppText variant="caption" weight="bold" color={color ? colors.onDark : colors.secondary}>{label}</AppText></Pressable>; }
function TimelineItem({ title, time, active }: { title: string; time?: string; active?: boolean }) { const colors = useThemeColors(); const styles = makeStyles(colors); return <View style={styles.timelineRow}><View style={styles.timelineMarker}><View style={[styles.dot, active && styles.activeDot]} />{!active ? <View style={styles.line} /> : null}</View><View style={styles.fill}><AppText variant="caption" weight="bold" color={active ? colors.primaryStrong : colors.navy}>{title}</AppText>{time ? <AppText variant="caption" color={colors.secondary}>{time}</AppText> : null}</View></View>; }

const makeStyles = (colors: ThemeColors) => StyleSheet.create({ content: { paddingBottom: spacing.xxl }, header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }, badges: { flexDirection: 'row', gap: spacing.xs }, open: { borderRadius: radius.round, backgroundColor: '#E5484D1F', paddingVertical: 6, paddingHorizontal: spacing.sm }, category: { borderRadius: radius.round, backgroundColor: '#E8A33D1F', paddingVertical: 6, paddingHorizontal: spacing.sm }, shipmentLink: { minHeight: 66, borderRadius: radius.md, backgroundColor: colors.surfaceMuted, padding: spacing.sm, flexDirection: 'row', alignItems: 'center' }, fill: { flex: 1 }, evidence: { flexDirection: 'row', gap: spacing.xs }, evidenceItem: { flex: 1, minHeight: 72, borderRadius: radius.md, backgroundColor: colors.surfaceMuted, alignItems: 'center', justifyContent: 'center', gap: 4, padding: 4 }, timeline: { paddingHorizontal: 4 }, timelineRow: { minHeight: 54, flexDirection: 'row', gap: spacing.sm }, timelineMarker: { alignItems: 'center' }, dot: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.primaryStrong }, activeDot: { backgroundColor: colors.white, borderWidth: 2, borderColor: colors.primaryStrong }, line: { width: 2, flex: 1, backgroundColor: colors.border }, note: { minHeight: 48, borderRadius: radius.md, backgroundColor: colors.surfaceMuted, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.xs }, actions: { flexDirection: 'row', gap: spacing.sm }, secondary: { flex: 1, minHeight: 52, borderRadius: radius.md, borderWidth: 1.5, borderColor: colors.border, alignItems: 'center', justifyContent: 'center' }, primary: { flex: 1, minHeight: 52, borderRadius: radius.md, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center' }, disabled: { opacity: 0.55 } });
'@

Write-Utf8File (Join-Path $AppPath "vercel.json") @'
{
  "buildCommand": "npm run build",
  "outputDirectory": "dist",
  "installCommand": "npm install",
  "rewrites": [
    {
      "source": "/(.*)",
      "destination": "/index.html"
    }
  ]
}
'@

if ($BackendUrl.Trim()) {
  $envProductionPath = Join-Path $AppPath ".env.production"
  $existing = if (Test-Path $envProductionPath) { Get-Content $envProductionPath -Raw } else { "" }
  if ($existing -match "(?m)^EXPO_PUBLIC_API_BASE_URL=") {
    $existing = $existing -replace "(?m)^EXPO_PUBLIC_API_BASE_URL=.*$", "EXPO_PUBLIC_API_BASE_URL=$BackendUrl"
  } else {
    $existing = $existing.TrimEnd() + "`r`nEXPO_PUBLIC_API_BASE_URL=$BackendUrl`r`n"
  }
  Write-Utf8File $envProductionPath $existing
}

Write-Host "Done. Mobile escrow/admin/dispatcher integration and Vercel config were applied to:"
Write-Host $AppPath
if ($BackendUrl.Trim()) {
  Write-Host "Frontend production API URL set to $BackendUrl"
} else {
  Write-Host "No BackendUrl was provided, so .env.production was not changed."
}
