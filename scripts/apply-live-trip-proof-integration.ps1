$ErrorActionPreference = "Stop"

$appRoot = "C:\Users\hp\Downloads\CargoLink-Logistics-main (6)\CargoLink-Logistics-main"

if (!(Test-Path (Join-Path $appRoot "package.json"))) {
  throw "Could not find the Expo app at $appRoot"
}

$backendTypesPath = Join-Path $appRoot "src\types\backend.ts"
$backendTypes = Get-Content $backendTypesPath -Raw
if ($backendTypes -notmatch "export type ShipmentLocationPing") {
  Add-Content -Path $backendTypesPath -Value @'

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
  status: 'SUBMITTED' | 'APPROVED' | 'REJECTED' | string;
  submittedAt: string;
};
'@
}

$portalServicePath = Join-Path $appRoot "src\services\portal-service.ts"
$portalService = Get-Content $portalServicePath -Raw
$portalService = $portalService.Replace("  id: string;`r`n  origin: string;", "  id: string;`r`n  shipmentId?: string;`r`n  origin: string;")
$portalService = $portalService.Replace("  id: string;`n  origin: string;", "  id: string;`n  shipmentId?: string;`n  origin: string;")
Set-Content -Path $portalServicePath -Value $portalService

$driverJobsPath = Join-Path $appRoot "app\(driver)\driver\(tabs)\jobs.tsx"
$driverJobs = Get-Content $driverJobsPath -Raw
$driverJobs = $driverJobs.Replace("router.push('/driver/pickup-confirmation');", "router.push({ pathname: '/driver/pickup-confirmation', params: { assignmentId: job.id, shipmentId: job.shipmentId ?? job.id } });")
Set-Content -Path $driverJobsPath -Value $driverJobs

$pickupConfirmation = @'
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { router, useLocalSearchParams } from 'expo-router';
import { useRef, useState } from 'react';
import { StyleSheet, TextInput, View } from 'react-native';

import { AppButton } from '@/src/components/common/AppButton';
import { AppText } from '@/src/components/common/AppText';
import { WaitingForTruckAssignment } from '@/src/components/driver/WaitingForTruckAssignment';
import { CargoMap } from '@/src/components/maps/CargoMap';
import type { CargoMapHandle } from '@/src/components/maps/CargoMap.types';
import { useMapSettings } from '@/src/store/map-settings-context';
import { MapControls } from '@/src/components/maps/MapChrome';
import { notify } from '@/src/lib/notify';
import { shipmentService } from '@/src/services/shipment-service';
import { trackingService } from '@/src/services/tracking-service';
import { useAuth } from '@/src/store/auth-context';
import { useDriverAssignment } from '@/src/store/driver-assignment-context';
import { radius, shadows, spacing, typography, useThemeColors, type ThemeColors } from '@/src/theme';

export default function PickupConfirmationScreen() {
  const { mode } = useDriverAssignment();
  if (mode === 'waiting') {
    return <WaitingForTruckAssignment title="Pickup is unavailable" subtitle="Pickup confirmation is locked until this driver receives an assigned truck." />;
  }
  return <AssignedPickupConfirmationScreen />;
}

function firstParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function AssignedPickupConfirmationScreen() {
  const colors = useThemeColors();
  const styles = makeStyles(colors);
  const mapRef = useRef<CargoMapHandle>(null);
  const { mapType, trafficEnabled, setMapType, setTrafficEnabled } = useMapSettings();
  const { session } = useAuth();
  const params = useLocalSearchParams<{ shipmentId?: string; assignmentId?: string }>();
  const shipmentId = firstParam(params.shipmentId);
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);

  async function confirmPickup() {
    if (!shipmentId || saving) {
      if (!shipmentId) notify('No shipment selected', 'Accept a live load first so pickup can be linked to a shipment.');
      return;
    }
    setSaving(true);
    try {
      await shipmentService.updateShipmentStatus(shipmentId, 'IN_TRANSIT', notes || 'Driver confirmed pickup and started the trip.', session?.accessToken);
      await trackingService.recordLocation(shipmentId, {
        latitude: 6.5244,
        longitude: 3.3792,
        speedKph: 0,
        note: 'Pickup confirmed.',
      }, session?.accessToken);
      notify('Pickup confirmed', 'Trip status and first location ping were saved.');
      router.replace({ pathname: '/driver/trip', params: { shipmentId } });
    } catch (error) {
      notify('Pickup could not be confirmed', error instanceof Error ? error.message : 'Please try again.');
    } finally {
      setSaving(false);
    }
  }

  return <View style={styles.screen}>
    <View style={styles.map}>
      <CargoMap ref={mapRef} mapType={mapType} trafficEnabled={trafficEnabled} />
      <MapControls mapRef={mapRef} mapType={mapType} trafficEnabled={trafficEnabled} onMapTypeChange={setMapType} onTrafficChange={setTrafficEnabled} style={{ top: 54 }} pinTop="42%" />
    </View>
    <View style={styles.sheet}>
      <View style={styles.handle} />
      <View style={styles.arrived}>
        <View style={styles.check}><MaterialIcons name="check" size={17} color={colors.onDark} /></View>
        <View>
          <AppText weight="extrabold">Arrived at pickup</AppText>
          <AppText variant="caption" color={colors.secondary}>{shipmentId ? `Shipment ${shipmentId}` : 'Live assignment required'}</AppText>
        </View>
      </View>
      <AppText variant="caption" weight="bold">CARGO CONDITION PHOTOS</AppText>
      <View style={styles.photos}>
        <View style={styles.add}><MaterialIcons name="add-a-photo" size={23} color={colors.secondary} /></View>
        <View style={[styles.photo, styles.photoOne]} />
        <View style={[styles.photo, styles.photoTwo]} />
      </View>
      <TextInput multiline placeholder="Add inspection notes" placeholderTextColor={colors.secondary} value={notes} onChangeText={setNotes} style={styles.notes} />
      <View style={styles.sender}>
        <View style={styles.avatar}><AppText weight="extrabold" color={colors.primaryText}>T</AppText></View>
        <View style={styles.fill}>
          <AppText weight="extrabold">Tracko customer</AppText>
          <AppText variant="caption" color={colors.secondary}>Pickup contact from shipment record</AppText>
        </View>
        <MaterialIcons name="phone" size={21} color={colors.primaryStrong} />
      </View>
      <AppButton title={saving ? 'Starting trip...' : 'Confirm pickup & start trip'} icon="local-shipping" disabled={saving || !shipmentId} onPress={confirmPickup} />
    </View>
  </View>;
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.map.background },
  map: { flex: 1 },
  sheet: { position: 'absolute', left: 0, right: 0, bottom: 0, borderTopLeftRadius: radius.sheet, borderTopRightRadius: radius.sheet, backgroundColor: colors.white, padding: spacing.lg, paddingTop: spacing.sm, gap: spacing.sm, ...(shadows.sheet ?? {}) },
  handle: { width: 42, height: 5, borderRadius: 3, backgroundColor: colors.border, alignSelf: 'center' },
  arrived: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  check: { width: 34, height: 34, borderRadius: 17, backgroundColor: colors.status.success, alignItems: 'center', justifyContent: 'center' },
  photos: { flexDirection: 'row', gap: spacing.sm },
  add: { width: 72, height: 72, borderRadius: radius.md, borderWidth: 1.5, borderStyle: 'dashed', borderColor: colors.border, alignItems: 'center', justifyContent: 'center' },
  photo: { width: 72, height: 72, borderRadius: radius.md },
  photoOne: { backgroundColor: '#9C8260' },
  photoTwo: { backgroundColor: '#71899E' },
  notes: { minHeight: 62, borderRadius: radius.md, backgroundColor: colors.surfaceMuted, padding: spacing.sm, color: colors.navy, fontFamily: typography.family, textAlignVertical: 'top' },
  sender: { minHeight: 62, flexDirection: 'row', alignItems: 'center', gap: spacing.sm, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, padding: spacing.sm },
  avatar: { width: 40, height: 40, borderRadius: 20, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center' },
  fill: { flex: 1 },
});
'@
Set-Content -Path (Join-Path $appRoot "app\(driver)\driver\pickup-confirmation.tsx") -Value $pickupConfirmation

$driverTrip = @'
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AppButton } from '@/src/components/common/AppButton';
import { AppText } from '@/src/components/common/AppText';
import { ThemedStatusBar } from '@/src/components/common/ThemedStatusBar';
import { WaitingForTruckAssignment } from '@/src/components/driver/WaitingForTruckAssignment';
import { CargoMap } from '@/src/components/maps/CargoMap';
import type { CargoMapHandle } from '@/src/components/maps/CargoMap.types';
import { useMapSettings } from '@/src/store/map-settings-context';
import { MapControls } from '@/src/components/maps/MapChrome';
import { confirmAction, notify } from '@/src/lib/notify';
import { portalService, type DriverPortalJob } from '@/src/services/portal-service';
import { shipmentService } from '@/src/services/shipment-service';
import { trackingService } from '@/src/services/tracking-service';
import { useAuth } from '@/src/store/auth-context';
import { useDriverAssignment } from '@/src/store/driver-assignment-context';
import { radius, shadows, spacing, useThemeColors, type ThemeColors } from '@/src/theme';

const TRIP_STAGES = [
  { status: 'IN_TRANSIT', label: 'Heading to pickup', action: 'Ping pickup location', done: 'Location ping saved' },
  { status: 'IN_TRANSIT', label: 'In transit', action: 'Arrived at destination', done: 'Arrival saved' },
  { status: 'DELIVERED', label: 'Delivered', action: 'Submit proof of delivery', done: 'Proof submitted' },
] as const;

export default function DriverActiveTripScreen() {
  const { mode } = useDriverAssignment();
  if (mode === 'waiting') return <WaitingForTruckAssignment title="No active trip without a truck" subtitle="Active trip tracking is paused because this driver account has not been assigned a truck." />;
  return <AssignedDriverActiveTripScreen />;
}

function firstParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function AssignedDriverActiveTripScreen() {
  const params = useLocalSearchParams<{ shipmentId?: string }>();
  const selectedShipmentId = firstParam(params.shipmentId);
  const { session } = useAuth();
  const [jobs, setJobs] = useState<DriverPortalJob[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    portalService.driver(session?.accessToken)
      .then((portal) => {
        if (active) setJobs(portal.jobs.filter((job) => job.status === 'ACCEPTED'));
      })
      .catch(() => notify('Trips unavailable', 'Could not load accepted trips.'))
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [session?.accessToken]);

  const selectedTrip = useMemo(
    () => jobs.find((job) => job.shipmentId === selectedShipmentId || job.id === selectedShipmentId),
    [jobs, selectedShipmentId],
  );

  if (selectedTrip) return <TripDetail job={selectedTrip} onBack={() => router.replace('/driver/trip')} />;
  return <TripList jobs={jobs} loading={loading} />;
}

function TripList({ jobs, loading }: { jobs: DriverPortalJob[]; loading: boolean }) {
  const colors = useThemeColors();
  const styles = makeStyles(colors);

  return <SafeAreaView style={styles.listScreen} edges={['top', 'left', 'right']}>
    <ThemedStatusBar />
    <View style={styles.listHeader}>
      <AppText variant="display" weight="extrabold">Active trips</AppText>
      <AppText color={colors.secondary}>{jobs.length ? `${jobs.length} accepted trip${jobs.length > 1 ? 's' : ''}` : 'No trips in progress'}</AppText>
    </View>
    {loading ? <View style={styles.empty}><ActivityIndicator color={colors.primaryStrong} /><AppText weight="extrabold">Loading trips...</AppText></View> : jobs.length === 0
      ? <View style={styles.empty}>
          <View style={styles.emptyIcon}><MaterialIcons name="local-shipping" size={30} color={colors.secondary} /></View>
          <AppText weight="extrabold">No active trips</AppText>
          <AppText variant="caption" color={colors.secondary} style={styles.emptyText}>Accept a load from the Jobs tab to start a new trip.</AppText>
          <View style={styles.emptyButton}><AppButton title="Browse jobs" icon="work-outline" variant="secondary" onPress={() => router.push('/driver/jobs')} /></View>
        </View>
      : <ScrollView contentContainerStyle={styles.list} showsVerticalScrollIndicator={false}>
          {jobs.map((job) => <TripCard key={job.id} job={job} />)}
        </ScrollView>}
  </SafeAreaView>;
}

function TripCard({ job }: { job: DriverPortalJob }) {
  const colors = useThemeColors();
  const styles = makeStyles(colors);
  return <Pressable accessibilityRole="button" accessibilityLabel={`Open trip ${job.shipmentId ?? job.id}`} onPress={() => router.push({ pathname: '/driver/trip', params: { shipmentId: job.shipmentId ?? job.id } })} style={({ pressed }) => [styles.card, pressed && styles.cardPressed]}>
    <View style={styles.cardTop}>
      <View style={styles.stagePill}><View style={styles.stageDot} /><AppText variant="caption" weight="bold" color={colors.primaryStrong}>Accepted</AppText></View>
      <AppText variant="caption" weight="bold" color={colors.secondary}>{job.shipmentId ?? job.id}</AppText>
    </View>
    <View style={styles.route}>
      <View style={styles.routeDots}><View style={styles.pickupDot} /><View style={styles.routeLine} /><View style={styles.destinationDot} /></View>
      <View style={styles.routeText}>
        <AppText variant="caption" weight="bold">{job.origin}</AppText>
        <AppText variant="caption" weight="bold">{job.destination}</AppText>
      </View>
    </View>
    <View style={styles.cardMeta}>
      <View style={styles.metaItem}><MaterialIcons name="inventory-2" size={14} color={colors.secondary} /><AppText variant="caption" color={colors.secondary}>{job.cargo}</AppText></View>
      <View style={styles.metaItem}><MaterialIcons name="schedule" size={14} color={colors.secondary} /><AppText variant="caption" color={colors.secondary}>Pickup {job.pickup}</AppText></View>
    </View>
    <View style={styles.cardBottom}>
      <AppText variant="caption" color={colors.secondary}>{job.price}</AppText>
      <View style={styles.openRow}><AppText variant="caption" weight="bold" color={colors.primaryStrong}>Open trip</AppText><MaterialIcons name="chevron-right" size={18} color={colors.primaryStrong} /></View>
    </View>
  </Pressable>;
}

function TripDetail({ job, onBack }: { job: DriverPortalJob; onBack: () => void }) {
  const colors = useThemeColors();
  const styles = makeStyles(colors);
  const { session } = useAuth();
  const shipmentId = job.shipmentId ?? job.id;
  const mapRef = useRef<CargoMapHandle>(null);
  const { mapType, trafficEnabled, setMapType, setTrafficEnabled } = useMapSettings();
  const [stageIndex, setStageIndex] = useState(0);
  const [acting, setActing] = useState(false);
  const stage = TRIP_STAGES[stageIndex];
  const isFinalStage = stageIndex >= TRIP_STAGES.length - 1;

  const onAdvance = () => {
    confirmAction(stage.action, `${stage.action} for shipment ${shipmentId}?`, 'Confirm', async () => {
      setActing(true);
      try {
        if (isFinalStage) {
          await trackingService.submitDeliveryProof(shipmentId, {
            photoUrl: `mock://pod/${shipmentId}`,
            signatureUrl: `mock://signature/${shipmentId}`,
            recipientName: 'Receiver',
            note: 'Driver submitted delivery proof from the mobile app.',
          }, session?.accessToken);
          notify('Proof submitted', `Delivery proof for ${shipmentId} was saved.`);
          onBack();
        } else {
          await trackingService.recordLocation(shipmentId, {
            latitude: 6.5244 + stageIndex * 0.08,
            longitude: 3.3792 + stageIndex * 0.08,
            speedKph: stageIndex === 0 ? 0 : 62,
            note: stage.done,
          }, session?.accessToken);
          await shipmentService.updateShipmentStatus(shipmentId, stage.status, stage.done, session?.accessToken);
          setStageIndex((value) => Math.min(value + 1, TRIP_STAGES.length - 1));
          notify(stage.done, `Next: ${TRIP_STAGES[Math.min(stageIndex + 1, TRIP_STAGES.length - 1)].label}.`);
        }
      } catch (error) {
        notify('Trip update failed', error instanceof Error ? error.message : 'Please try again.');
      } finally {
        setActing(false);
      }
    });
  };

  return <View style={styles.screen}><ThemedStatusBar /><CargoMap ref={mapRef} mapType={mapType} trafficEnabled={trafficEnabled} />
    <SafeAreaView pointerEvents="box-none" style={styles.overlay} edges={['top', 'left', 'right']}>
      <View style={styles.topRow}>
        <Pressable accessibilityRole="button" accessibilityLabel="Back to active trips" onPress={onBack} style={styles.back}><MaterialIcons name="arrow-back" size={22} color={colors.navy} /></Pressable>
        <View style={styles.gps}><View style={styles.gpsDot} /><View><AppText variant="caption" color={colors.onInverseMuted}>GPS tracking on - {shipmentId}</AppText><AppText variant="caption" weight="bold" color={colors.onInverse}>{job.distance} - {job.origin} to {job.destination}</AppText></View></View>
      </View>
    </SafeAreaView>
    <MapControls mapRef={mapRef} mapType={mapType} trafficEnabled={trafficEnabled} onMapTypeChange={setMapType} onTrafficChange={setTrafficEnabled} style={{ top: 82 }} />
    <View style={styles.sheet}><View style={styles.handle} />
      <StageProgress stageIndex={stageIndex} />
      <AppText variant="caption" weight="bold" color={colors.secondary}>CURRENT STAGE</AppText>
      <AppText variant="sectionTitle" weight="extrabold">{stage.label}</AppText>
      <AppText variant="caption" color={colors.secondary}>Step {stageIndex + 1} of {TRIP_STAGES.length} - {job.origin} to {job.destination}</AppText>
      <View style={styles.customer}>
        <View style={styles.avatar}><AppText weight="extrabold" color={colors.primaryText}>T</AppText></View>
        <View style={styles.customerText}><AppText variant="caption" weight="extrabold">Tracko customer</AppText><AppText variant="caption" color={colors.secondary}>{job.cargo}</AppText></View>
        <Pressable accessibilityRole="button" accessibilityLabel="Call customer" onPress={() => router.push('/driver/call')} style={styles.phone}><MaterialIcons name="phone" size={20} color={colors.primaryStrong} /></Pressable>
      </View>
      <AppButton title={acting ? 'Saving...' : stage.action} icon={isFinalStage ? 'task-alt' : 'check-circle-outline'} disabled={acting} onPress={onAdvance} />
    </View>
  </View>;
}

function StageProgress({ stageIndex }: { stageIndex: number }) {
  const colors = useThemeColors();
  const styles = makeStyles(colors);
  return <View style={styles.progress}>
    {TRIP_STAGES.map((item, index) => {
      const complete = index < stageIndex;
      const active = index === stageIndex;
      return <View key={item.label} style={styles.progressSegment}>
        {index > 0 ? <View style={[styles.progressConnector, index <= stageIndex && styles.progressConnectorDone]} /> : null}
        <View style={[styles.step, complete && styles.stepComplete, active && styles.stepActive]}>
          {complete ? <MaterialIcons name="check" size={13} color={colors.onDark} /> : <AppText variant="caption" weight="bold" color={active ? colors.primaryText : colors.secondary}>{index + 1}</AppText>}
        </View>
      </View>;
    })}
  </View>;
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.map.background },
  overlay: { ...StyleSheet.absoluteFillObject, paddingHorizontal: spacing.md },
  topRow: { marginTop: spacing.xs, flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  back: { width: 44, height: 44, borderRadius: radius.lg, backgroundColor: colors.white, alignItems: 'center', justifyContent: 'center', ...(shadows.floating ?? {}) },
  gps: { flex: 1, minHeight: 58, borderRadius: radius.lg, backgroundColor: colors.inverse, paddingHorizontal: spacing.md, flexDirection: 'row', alignItems: 'center', gap: spacing.sm, ...(shadows.floating ?? {}) },
  gpsDot: { width: 9, height: 9, borderRadius: 5, backgroundColor: colors.primary, shadowColor: colors.primary, shadowOpacity: 0.5, shadowRadius: 5 },
  sheet: { position: 'absolute', left: 0, right: 0, bottom: 0, borderTopLeftRadius: radius.sheet, borderTopRightRadius: radius.sheet, backgroundColor: colors.white, padding: spacing.lg, paddingTop: spacing.sm, gap: spacing.sm, ...(shadows.sheet ?? {}) },
  handle: { width: 42, height: 5, borderRadius: 3, backgroundColor: colors.border, alignSelf: 'center', marginBottom: spacing.xs },
  progress: { flexDirection: 'row', alignItems: 'center' },
  progressSegment: { flexDirection: 'row', alignItems: 'center', flex: 1 },
  progressConnector: { flex: 1, height: 3, backgroundColor: colors.border },
  progressConnectorDone: { backgroundColor: colors.status.success },
  step: { width: 24, height: 24, borderRadius: 12, borderWidth: 2, borderColor: colors.border, alignItems: 'center', justifyContent: 'center' },
  stepComplete: { borderColor: colors.status.success, backgroundColor: colors.status.success },
  stepActive: { borderColor: colors.primary, backgroundColor: colors.primary },
  customer: { minHeight: 66, flexDirection: 'row', alignItems: 'center', gap: spacing.sm, borderWidth: 1.5, borderColor: colors.border, borderRadius: radius.md, padding: spacing.sm },
  avatar: { width: 42, height: 42, borderRadius: 21, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center' },
  customerText: { flex: 1 },
  phone: { width: 42, height: 42, borderRadius: radius.sm, backgroundColor: colors.surfaceMuted, alignItems: 'center', justifyContent: 'center' },
  listScreen: { flex: 1, backgroundColor: colors.background },
  listHeader: { paddingHorizontal: spacing.lg, paddingTop: spacing.sm, paddingBottom: spacing.md, gap: 2 },
  list: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xxl, gap: spacing.sm },
  card: { borderRadius: radius.lg, backgroundColor: colors.white, borderWidth: 1, borderColor: colors.border, padding: spacing.md, gap: spacing.sm },
  cardPressed: { opacity: 0.85, transform: [{ scale: 0.99 }] },
  cardTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  stagePill: { flexDirection: 'row', alignItems: 'center', gap: 6, borderRadius: radius.round, backgroundColor: colors.surfaceMuted, paddingVertical: 5, paddingHorizontal: spacing.sm },
  stageDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: colors.primaryStrong },
  route: { flexDirection: 'row', gap: spacing.sm },
  routeDots: { alignItems: 'center', paddingTop: 4 },
  pickupDot: { width: 9, height: 9, borderRadius: 5, backgroundColor: colors.navy },
  routeLine: { width: 2, height: 18, backgroundColor: colors.border },
  destinationDot: { width: 9, height: 9, borderRadius: 5, borderWidth: 2, borderColor: colors.primaryStrong },
  routeText: { flex: 1, gap: spacing.sm },
  cardMeta: { flexDirection: 'row', gap: spacing.lg },
  metaItem: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  cardBottom: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  openRow: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: spacing.xl, gap: spacing.xs },
  emptyIcon: { width: 68, height: 68, borderRadius: 34, backgroundColor: colors.surfaceMuted, alignItems: 'center', justifyContent: 'center', marginBottom: spacing.xs },
  emptyText: { textAlign: 'center' },
  emptyButton: { marginTop: spacing.md, alignSelf: 'stretch' },
});
'@
Set-Content -Path (Join-Path $appRoot "app\(driver)\driver\(tabs)\trip.tsx") -Value $driverTrip

$customerTrack = @'
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { router } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AppText } from '@/src/components/common/AppText';
import { StatusBadge } from '@/src/components/common/StatusBadge';
import { CargoMap } from '@/src/components/maps/CargoMap';
import type { CargoMapHandle } from '@/src/components/maps/CargoMap.types';
import { useMapSettings } from '@/src/store/map-settings-context';
import { MapControls } from '@/src/components/maps/MapChrome';
import { portalService, type CustomerPortal } from '@/src/services/portal-service';
import { trackingService } from '@/src/services/tracking-service';
import { useAuth } from '@/src/store/auth-context';
import { radius, shadows, spacing, useThemeColors, type ThemeColors } from '@/src/theme';
import type { ShipmentLocationPing } from '@/src/types/backend';

export default function TrackShipmentScreen() {
  const colors = useThemeColors();
  const styles = makeStyles(colors);
  const mapRef = useRef<CargoMapHandle>(null);
  const { mapType, trafficEnabled, setMapType, setTrafficEnabled } = useMapSettings();
  const { session } = useAuth();
  const [portal, setPortal] = useState<CustomerPortal | null>(null);
  const [location, setLocation] = useState<ShipmentLocationPing | null>(null);
  const [loading, setLoading] = useState(true);

  const shipment = useMemo(() => portal?.activeShipment ?? portal?.recentShipments?.[0] ?? null, [portal]);

  useEffect(() => {
    let active = true;
    async function load() {
      setLoading(true);
      try {
        const nextPortal = await portalService.customer(session?.accessToken);
        if (!active) return;
        setPortal(nextPortal);
        const nextShipment = nextPortal.activeShipment ?? nextPortal.recentShipments?.[0];
        if (nextShipment?.id) {
          const latest = await trackingService.currentLocation(nextShipment.id, session?.accessToken);
          if (active) setLocation(latest);
        }
      } finally {
        if (active) setLoading(false);
      }
    }
    void load();
    const timer = setInterval(load, 15000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [session?.accessToken]);

  return <View style={styles.screen}>
    <CargoMap ref={mapRef} mapType={mapType} trafficEnabled={trafficEnabled} />
    <SafeAreaView pointerEvents="box-none" style={styles.overlay} edges={['top', 'left', 'right']}>
      <View style={styles.header}>
        <Pressable accessibilityRole="button" accessibilityLabel="Go back" onPress={() => router.back()} style={styles.back}><MaterialIcons name="arrow-back" size={23} color={colors.navy} /></Pressable>
        <View style={styles.headerText}>
          <AppText weight="extrabold">{shipment ? `Shipment ${shipment.id}` : 'Track shipment'}</AppText>
          <AppText variant="caption" color={colors.secondary}>{shipment ? `${shipment.origin} to ${shipment.destination}` : 'No active shipment yet'}</AppText>
        </View>
        {shipment ? <StatusBadge status={shipment.status} /> : null}
      </View>
    </SafeAreaView>
    <MapControls mapRef={mapRef} mapType={mapType} trafficEnabled={trafficEnabled} onMapTypeChange={setMapType} onTrafficChange={setTrafficEnabled} style={{ bottom: 214 }} />
    <View style={styles.sheet}><View style={styles.handle} />
      {loading ? <View style={styles.loading}><ActivityIndicator color={colors.primaryStrong} /><AppText color={colors.secondary}>Loading live tracking...</AppText></View> : null}
      <View style={styles.eta}>
        <View><AppText variant="caption" color={colors.secondary}>Latest update</AppText><AppText variant="display" weight="extrabold">{location ? 'Live' : 'Waiting'}</AppText></View>
        <View style={styles.lastUpdate}><AppText variant="caption" color={colors.secondary}>Last ping</AppText><AppText variant="caption" weight="bold">{location ? new Date(location.createdAt).toLocaleTimeString() : 'No ping yet'}</AppText></View>
      </View>
      <View style={styles.driver}>
        <View style={styles.avatar}><AppText weight="extrabold" color={colors.onDark}>D</AppText></View>
        <View style={styles.driverText}><AppText variant="input" weight="extrabold">Assigned driver</AppText><AppText variant="caption" color={colors.secondary}>{location ? `${location.latitude.toFixed(4)}, ${location.longitude.toFixed(4)}` : 'Location will appear after driver starts trip'}</AppText></View>
        <View style={styles.contact}><Pressable accessibilityRole="button" accessibilityLabel="Call driver" onPress={() => router.push('/customer/call')} style={styles.contactButton}><MaterialIcons name="phone" size={21} color={colors.primaryStrong} /></Pressable><Pressable accessibilityRole="button" accessibilityLabel="Message driver" onPress={() => router.push({ pathname: '/customer/messages/[thread]', params: { thread: 'driver' } })} style={[styles.contactButton, styles.messageButton]}><MaterialIcons name="chat-bubble-outline" size={20} color={colors.primaryText} /></Pressable></View>
      </View>
    </View>
  </View>;
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({ screen: { flex: 1, backgroundColor: colors.map.background }, overlay: { ...StyleSheet.absoluteFillObject, paddingHorizontal: spacing.md }, header: { minHeight: 66, marginTop: spacing.xs, flexDirection: 'row', alignItems: 'center', gap: spacing.xs, borderRadius: radius.lg, backgroundColor: colors.white, paddingHorizontal: spacing.xs, ...(shadows.floating ?? {}) }, back: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }, headerText: { flex: 1 }, sheet: { position: 'absolute', left: 0, right: 0, bottom: 0, borderTopLeftRadius: radius.sheet, borderTopRightRadius: radius.sheet, backgroundColor: colors.white, padding: spacing.lg, paddingTop: spacing.sm, gap: spacing.md, ...(shadows.sheet ?? {}) }, handle: { width: 42, height: 5, borderRadius: 3, backgroundColor: colors.border, alignSelf: 'center' }, loading: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm }, eta: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between' }, lastUpdate: { alignItems: 'flex-end', paddingBottom: 5 }, driver: { borderTopWidth: 1, borderTopColor: colors.border, paddingTop: spacing.md, flexDirection: 'row', alignItems: 'center', gap: spacing.sm }, avatar: { width: 48, height: 48, borderRadius: 24, backgroundColor: colors.inverse, alignItems: 'center', justifyContent: 'center' }, driverText: { flex: 1 }, contact: { flexDirection: 'row', gap: spacing.xs }, contactButton: { width: 44, height: 44, borderRadius: radius.md, backgroundColor: colors.surfaceMuted, alignItems: 'center', justifyContent: 'center' }, messageButton: { backgroundColor: colors.primary } });
'@
Set-Content -Path (Join-Path $appRoot "app\(customer)\customer\(tabs)\track.tsx") -Value $customerTrack

Write-Host "Done. Live trip, pickup, driver proof, and customer tracking screens were patched."
Write-Host "Restart Expo with: npx expo start --lan --clear"
