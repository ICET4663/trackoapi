$ErrorActionPreference = "Stop"

$appRoot = "C:\Users\hp\Downloads\CargoLink-Logistics-main (6)\CargoLink-Logistics-main"

if (!(Test-Path (Join-Path $appRoot "package.json"))) {
  throw "Could not find the Expo app at $appRoot"
}

$dispatcherAssignment = @'
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { router } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';

import { AppButton } from '@/src/components/common/AppButton';
import { AppText } from '@/src/components/common/AppText';
import { ScreenContainer } from '@/src/components/common/ScreenContainer';
import { notify } from '@/src/lib/notify';
import { shipmentService } from '@/src/services/shipment-service';
import { useAuth } from '@/src/store/auth-context';
import { radius, spacing, useThemeColors, type ThemeColors } from '@/src/theme';
import type { AvailableDriverRecord, ShipmentRecord } from '@/src/types/backend';

export default function Assignment() {
  const colors = useThemeColors();
  const styles = makeStyles(colors);
  const { session } = useAuth();
  const [drivers, setDrivers] = useState<AvailableDriverRecord[]>([]);
  const [shipments, setShipments] = useState<ShipmentRecord[]>([]);
  const [selectedShipmentId, setSelectedShipmentId] = useState<string>();
  const [assignedDriverId, setAssignedDriverId] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [assigning, setAssigning] = useState<string>();

  useEffect(() => {
    let active = true;
    async function load() {
      setLoading(true);
      try {
        const [nextShipments, nextDrivers] = await Promise.all([
          shipmentService.listShipments(session?.accessToken, 'DISPATCHER'),
          shipmentService.availableDrivers(session?.accessToken),
        ]);
        if (!active) return;
        setShipments(nextShipments);
        setDrivers(nextDrivers);
        setSelectedShipmentId(nextShipments.find((shipment) => shipment.status !== 'COMPLETED')?.id ?? nextShipments[0]?.id);
      } catch {
        if (active) notify('Assignment unavailable', 'Could not load live driver matches. Check the backend and try again.');
      } finally {
        if (active) setLoading(false);
      }
    }
    void load();
    return () => {
      active = false;
    };
  }, [session?.accessToken]);

  const selectedShipment = useMemo(
    () => shipments.find((shipment) => shipment.id === selectedShipmentId) ?? shipments[0],
    [selectedShipmentId, shipments],
  );

  async function assign(driver: AvailableDriverRecord) {
    if (!selectedShipment || assigning) return;
    setAssigning(driver.id);
    try {
      const assignment = await shipmentService.offerAssignment(
        selectedShipment.id,
        { driverId: driver.id, vehicleId: driver.vehicles[0]?.id },
        session?.accessToken,
      );
      setAssignedDriverId(driver.id);
      notify('Driver assigned', `${driver.fullName} has been offered shipment ${assignment.shipmentId}.`);
    } catch {
      notify('Assignment failed', 'The driver could not be assigned. Please try again.');
    } finally {
      setAssigning(undefined);
    }
  }

  return (
    <ScreenContainer>
      <View style={styles.header}>
        <MaterialIcons name="arrow-back" size={23} color={colors.navy} onPress={() => router.back()} />
        <AppText variant="title" weight="extrabold">Assign driver</AppText>
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.primaryStrong} />
          <AppText color={colors.secondary}>Loading live shipment and driver matches...</AppText>
        </View>
      ) : !selectedShipment ? (
        <View style={styles.center}>
          <MaterialIcons name="inventory-2" size={28} color={colors.secondary} />
          <AppText weight="extrabold">No shipment ready for assignment</AppText>
          <AppText variant="caption" color={colors.secondary}>Create a customer shipment first, then return here.</AppText>
        </View>
      ) : (
        <>
          <View style={styles.shipment}>
            <AppText variant="caption" color={colors.secondary}>{selectedShipment.id} - {selectedShipment.origin} to {selectedShipment.destination}</AppText>
            <AppText weight="bold">{selectedShipment.cargoType} - {selectedShipment.truckType} - {selectedShipment.status}</AppText>
          </View>

          {shipments.length > 1 ? (
            <View style={styles.selector}>
              {shipments.slice(0, 4).map((shipment) => (
                <Pressable key={shipment.id} accessibilityRole="button" onPress={() => setSelectedShipmentId(shipment.id)} style={[styles.selectorButton, selectedShipment.id === shipment.id && styles.selectorActive]}>
                  <AppText variant="caption" weight="bold" color={selectedShipment.id === shipment.id ? colors.primaryText : colors.navy}>{shipment.id}</AppText>
                </Pressable>
              ))}
            </View>
          ) : null}

          <View style={styles.label}>
            <MaterialIcons name="verified-user" size={18} color={colors.primaryStrong} />
            <AppText weight="extrabold">Live recommended matches</AppText>
          </View>

          {drivers.length ? drivers.map((driver) => {
            const vehicle = driver.vehicles[0];
            const assigned = assignedDriverId === driver.id;
            return (
              <View key={driver.id} style={[styles.driver, assigned && styles.selected]}>
                <View style={styles.avatar}><AppText weight="extrabold" color={colors.onDark}>{driver.fullName[0] ?? 'D'}</AppText></View>
                <View style={styles.fill}>
                  <AppText weight="extrabold">{driver.fullName}</AppText>
                  <AppText variant="caption" color={colors.secondary}>{driver.phone} - {driver.verificationStatus}</AppText>
                </View>
                <AppText variant="caption" weight="bold" color={colors.primaryStrong}>{vehicle?.plateNumber ?? 'No truck'}</AppText>
                <View style={styles.footer}>
                  <AppText variant="caption" color={colors.secondary}>{vehicle?.type ?? 'Vehicle not attached'} - {vehicle?.capacityKg ? `${vehicle.capacityKg}kg` : 'capacity pending'}</AppText>
                  <Pressable accessibilityRole="button" accessibilityLabel={`Assign ${driver.fullName}`} disabled={Boolean(assigning) || !vehicle} onPress={() => void assign(driver)} style={[styles.assign, assigned && styles.assigned, (!vehicle || assigning === driver.id) && styles.disabled]}>
                    <AppText variant="caption" weight="bold" color={assigned ? colors.onDark : colors.primaryText}>{assigning === driver.id ? 'Sending...' : assigned ? 'Offered' : 'Assign'}</AppText>
                  </Pressable>
                </View>
              </View>
            );
          }) : (
            <View style={styles.center}>
              <MaterialIcons name="person-search" size={28} color={colors.secondary} />
              <AppText weight="extrabold">No verified drivers yet</AppText>
              <AppText variant="caption" color={colors.secondary}>Seed or register a verified driver with a truck to assign shipments.</AppText>
            </View>
          )}
        </>
      )}
    </ScreenContainer>
  );
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  shipment: { borderRadius: radius.md, backgroundColor: colors.surfaceMuted, padding: spacing.sm, gap: 3 },
  selector: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  selectorButton: { minHeight: 34, borderRadius: radius.round, borderWidth: 1, borderColor: colors.border, paddingHorizontal: spacing.sm, alignItems: 'center', justifyContent: 'center' },
  selectorActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  label: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  center: { minHeight: 180, alignItems: 'center', justifyContent: 'center', gap: spacing.sm, padding: spacing.lg },
  driver: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: spacing.sm, borderRadius: radius.lg, borderWidth: 1.5, borderColor: colors.border, padding: spacing.sm },
  selected: { borderWidth: 2, borderColor: colors.status.success, backgroundColor: colors.surfaceMuted },
  avatar: { width: 44, height: 44, borderRadius: 22, backgroundColor: colors.inverse, alignItems: 'center', justifyContent: 'center' },
  fill: { flex: 1 },
  footer: { width: '100%', borderTopWidth: 1, borderTopColor: colors.border, paddingTop: spacing.sm, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
  assign: { minHeight: 38, borderRadius: radius.sm, backgroundColor: colors.primary, paddingHorizontal: spacing.md, alignItems: 'center', justifyContent: 'center' },
  assigned: { backgroundColor: colors.status.success },
  disabled: { opacity: 0.55 },
});
'@

$driverJobs = @'
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { router } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AppText } from '@/src/components/common/AppText';
import { ThemedStatusBar } from '@/src/components/common/ThemedStatusBar';
import { WaitingForTruckAssignment } from '@/src/components/driver/WaitingForTruckAssignment';
import { notify } from '@/src/lib/notify';
import { portalService, type DriverPortalJob } from '@/src/services/portal-service';
import { shipmentService } from '@/src/services/shipment-service';
import { useAuth } from '@/src/store/auth-context';
import { useDriverAssignment } from '@/src/store/driver-assignment-context';
import { radius, spacing, useThemeColors, type ThemeColors } from '@/src/theme';

const FILTERS = ['All', 'Offered', 'Accepted', 'Today'];

export default function Jobs() {
  const { mode } = useDriverAssignment();
  if (mode === 'waiting') return <WaitingForTruckAssignment title="Jobs unlock after truck assignment" subtitle="You can review previous packages, but new packages stay hidden until Tracko operations assigns a truck." />;
  return <AssignedJobs />;
}

function AssignedJobs() {
  const colors = useThemeColors();
  const styles = makeStyles(colors);
  const { session } = useAuth();
  const [filter, setFilter] = useState('All');
  const [jobs, setJobs] = useState<DriverPortalJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState<string>();

  async function load() {
    setLoading(true);
    try {
      const portal = await portalService.driver(session?.accessToken);
      setJobs(portal.jobs);
    } catch {
      notify('Jobs unavailable', 'Could not load live shipment offers. Check the backend and try again.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, [session?.accessToken]);

  const visibleJobs = useMemo(() => jobs.filter((job) => (
    filter === 'All' ||
    (filter === 'Offered' ? job.status === 'OFFERED' : filter === 'Accepted' ? job.status === 'ACCEPTED' : job.pickup.includes('Today'))
  )), [filter, jobs]);

  async function respond(job: DriverPortalJob, action: 'accept' | 'reject') {
    if (acting) return;
    setActing(job.id);
    try {
      if (action === 'accept') {
        await shipmentService.acceptAssignment(job.id, session?.accessToken);
        notify('Load accepted', 'Dispatch and the customer have been notified.');
        router.push('/driver/pickup-confirmation');
      } else {
        await shipmentService.rejectAssignment(job.id, session?.accessToken);
        notify('Load rejected', 'Dispatch can offer the shipment to another driver.');
      }
      await load();
    } catch {
      notify('Action failed', 'Could not update the assignment. Please try again.');
    } finally {
      setActing(undefined);
    }
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'left', 'right']}>
      <ThemedStatusBar />
      <FlatList
        data={visibleJobs}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
        ListHeaderComponent={
          <View style={styles.header}>
            <View style={styles.titleRow}>
              <View>
                <AppText variant="display" weight="extrabold">Available jobs</AppText>
                <AppText color={colors.secondary}>Live assignment offers from Tracko dispatch</AppText>
              </View>
              <View style={styles.count}><AppText variant="caption" weight="extrabold" color={colors.primaryText}>{jobs.filter((job) => job.status === 'OFFERED').length} new</AppText></View>
            </View>
            <View style={styles.filters}>
              {FILTERS.map((item) => (
                <Pressable key={item} accessibilityRole="radio" accessibilityState={{ selected: filter === item }} onPress={() => setFilter(item)} style={[styles.filter, filter === item && styles.filterActive]}>
                  <AppText variant="caption" weight="bold" color={filter === item ? colors.primaryText : colors.navy}>{item}</AppText>
                </Pressable>
              ))}
            </View>
          </View>
        }
        ListEmptyComponent={
          <View style={styles.empty}>
            {loading ? <ActivityIndicator color={colors.primaryStrong} /> : <MaterialIcons name="local-shipping" size={30} color={colors.secondary} />}
            <AppText weight="extrabold">{loading ? 'Loading jobs...' : 'No live offers yet'}</AppText>
            {!loading ? <AppText variant="caption" color={colors.secondary}>Ask dispatch to assign a shipment, then refresh this screen.</AppText> : null}
          </View>
        }
        renderItem={({ item }) => <JobCard job={item} acting={acting === item.id} onAccept={() => void respond(item, 'accept')} onReject={() => void respond(item, 'reject')} />}
        ItemSeparatorComponent={() => <View style={styles.separator} />}
      />
    </SafeAreaView>
  );
}

function JobCard({ job, acting, onAccept, onReject }: { job: DriverPortalJob; acting: boolean; onAccept: () => void; onReject: () => void }) {
  const colors = useThemeColors();
  const styles = makeStyles(colors);
  const offered = job.status === 'OFFERED';
  return (
    <View style={styles.card}>
      <View style={styles.cardTop}>
        <View style={styles.tags}>
          <View style={styles.tag}><AppText variant="caption" weight="bold">{job.truck}</AppText></View>
          <AppText variant="caption" color={colors.secondary}>{job.status}</AppText>
        </View>
        <AppText variant="sectionTitle" weight="extrabold">{job.price}</AppText>
      </View>
      <View style={styles.route}>
        <View style={styles.routeDots}><View style={styles.pickupDot} /><View style={styles.routeLine} /><View style={styles.destinationDot} /></View>
        <View style={styles.routeText}>
          <AppText variant="caption" weight="bold">{job.origin}</AppText>
          <AppText variant="caption" weight="bold">{job.destination}</AppText>
        </View>
      </View>
      <View style={styles.metaRow}>
        <View style={styles.meta}><MaterialIcons name="inventory-2" size={15} color={colors.secondary} /><AppText variant="caption" color={colors.secondary}>{job.cargo}</AppText></View>
        <View style={styles.meta}><MaterialIcons name="straighten" size={15} color={colors.secondary} /><AppText variant="caption" color={colors.secondary}>{job.km}</AppText></View>
      </View>
      <View style={styles.pickupRow}><MaterialIcons name="schedule" size={15} color={colors.primaryStrong} /><AppText variant="caption" weight="bold" color={colors.primaryStrong}>Pickup {job.pickup}</AppText></View>
      <View style={styles.actions}>
        <Pressable accessibilityRole="button" onPress={() => router.push('/driver/load-offer')} style={styles.secondaryButton}><AppText variant="caption" weight="bold">Details</AppText></Pressable>
        {offered ? <Pressable accessibilityRole="button" disabled={acting} onPress={onReject} style={styles.rejectButton}><AppText variant="caption" weight="bold">Reject</AppText></Pressable> : null}
        <Pressable accessibilityRole="button" disabled={!offered || acting} onPress={onAccept} style={[styles.primaryButton, (!offered || acting) && styles.disabled]}><AppText variant="caption" weight="bold" color={colors.primaryText}>{acting ? 'Updating...' : offered ? 'Accept load' : 'Handled'}</AppText></Pressable>
      </View>
    </View>
  );
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.lg, paddingBottom: spacing.xxl },
  header: { gap: spacing.md, marginBottom: spacing.md },
  titleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  count: { borderRadius: radius.round, backgroundColor: colors.primary, paddingVertical: 5, paddingHorizontal: spacing.sm },
  filters: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  filter: { minHeight: 36, borderRadius: radius.round, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surfaceMuted, paddingHorizontal: spacing.sm, alignItems: 'center', justifyContent: 'center' },
  filterActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  separator: { height: spacing.sm },
  empty: { minHeight: 260, alignItems: 'center', justifyContent: 'center', gap: spacing.sm, padding: spacing.lg },
  card: { borderRadius: radius.lg, backgroundColor: colors.white, borderWidth: 1, borderColor: colors.border, padding: spacing.md, gap: spacing.sm },
  cardTop: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between' },
  tags: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  tag: { borderRadius: radius.sm, backgroundColor: colors.surfaceMuted, paddingVertical: 5, paddingHorizontal: spacing.xs },
  route: { flexDirection: 'row', gap: spacing.sm },
  routeDots: { alignItems: 'center', paddingTop: 4 },
  pickupDot: { width: 9, height: 9, borderRadius: 5, backgroundColor: colors.navy },
  routeLine: { width: 2, height: 18, backgroundColor: colors.border },
  destinationDot: { width: 9, height: 9, borderRadius: 5, borderWidth: 2, borderColor: colors.primaryStrong },
  routeText: { flex: 1, gap: spacing.sm },
  metaRow: { flexDirection: 'row', gap: spacing.lg },
  meta: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  pickupRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  actions: { flexDirection: 'row', gap: spacing.xs, borderTopWidth: 1, borderTopColor: colors.border, paddingTop: spacing.sm },
  secondaryButton: { flex: 1, minHeight: 42, borderRadius: radius.sm, borderWidth: 1.5, borderColor: colors.border, alignItems: 'center', justifyContent: 'center' },
  rejectButton: { flex: 1, minHeight: 42, borderRadius: radius.sm, borderWidth: 1.5, borderColor: colors.border, alignItems: 'center', justifyContent: 'center' },
  primaryButton: { flex: 2, minHeight: 42, borderRadius: radius.sm, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center' },
  disabled: { opacity: 0.55 },
});
'@

Set-Content -Path (Join-Path $appRoot "app\(dispatcher)\dispatcher\assignment.tsx") -Value $dispatcherAssignment
Set-Content -Path (Join-Path $appRoot "app\(driver)\driver\(tabs)\jobs.tsx") -Value $driverJobs

Write-Host "Done. Dispatcher assignment and driver jobs screens now use the live backend workflow."
Write-Host "Restart Expo with: npx expo start --lan --clear"
