// One source for the pricing defaults: the quote formula (MapsProviderService) and the admin
// Platform settings list (SettingsService) both read from here, so the admin screen always
// shows the values new quotes actually use.
//
// Fuel prices are the filling-station price per litre (petrol for pickups and vans, diesel
// for trucks). Admins update them as pump prices move; quotes never show them to customers.
// Starting values: Lagos pump prices reported in September 2026 (petrol NGN 1,385 at NNPC,
// diesel about NGN 1,700 after the Dangote ex-depot rise).

export const PRICING_VERSION = '2026-11-fuel-indexed-1';

export const PRICING_SETTING_DEFAULTS = {
  // Trako's commission, added on top of what the trip costs the carrier. The key is the
  // admin "Platform fee" setting, which existed before it was applied to quotes.
  fee: 7.5,
  pricingPetrolPriceNgn: 1_385,
  pricingDieselPriceNgn: 1_700,
  // Share of the trip back that a truck usually drives empty after a one-way load.
  pricingEmptyReturnPercent: 70,
  pricingTollAllowanceNgn: 0,
  pricingDemandSurgePercent: 0,
  pricingQuoteValidityMinutes: 30,
  pricingFlatbedBaseFareNgn: 50_000,
  pricingFlatbedOperatingPerKmNgn: 380,
  pricingFlatbedMinimumFareNgn: 100_000,
  pricingBoxBaseFareNgn: 35_000,
  pricingBoxOperatingPerKmNgn: 300,
  pricingBoxMinimumFareNgn: 70_000,
  pricingTipperBaseFareNgn: 50_000,
  pricingTipperOperatingPerKmNgn: 400,
  pricingTipperMinimumFareNgn: 100_000,
  pricingTankerBaseFareNgn: 60_000,
  pricingTankerOperatingPerKmNgn: 420,
  pricingTankerMinimumFareNgn: 120_000,
  pricingStandardBaseFareNgn: 35_000,
  pricingStandardOperatingPerKmNgn: 320,
  pricingStandardMinimumFareNgn: 70_000,
} as const;

export type PricingSettingKey = keyof typeof PRICING_SETTING_DEFAULTS;

type SettingDefinition = {
  key: PricingSettingKey;
  title: string;
  description: string;
  label: string;
  helper: string;
  min: number;
  max: number;
};

const classes = [
  ['Flatbed', 'Flatbed'],
  ['Box', 'Box truck'],
  ['Tipper', 'Tipper'],
  ['Tanker', 'Tanker'],
  ['Standard', 'Standard truck'],
] as const;

// Admin Platform settings entries for pricing, in display order.
export const PRICING_SETTING_DEFINITIONS: SettingDefinition[] = [
  { key: 'fee', title: 'Platform fee', description: "Trako's commission, added on top of the carrier's trip cost in every new quote and kept by Trako when the payment is released.", label: 'Commission (%)', helper: 'Allowed range: 0-30%. Shipments already booked keep the commission they were quoted with.', min: 0, max: 30 },
  { key: 'pricingPetrolPriceNgn', title: 'Petrol pump price', description: 'Filling-station price of petrol per litre, used for pickups and vans. Not shown to customers.', label: 'Petrol (NGN per litre)', helper: 'Update when pump prices change. Allowed range: NGN 200-5,000.', min: 200, max: 5_000 },
  { key: 'pricingDieselPriceNgn', title: 'Diesel pump price', description: 'Filling-station price of diesel per litre, used for trucks. Not shown to customers.', label: 'Diesel (NGN per litre)', helper: 'Update when pump prices change. Allowed range: NGN 200-5,000.', min: 200, max: 5_000 },
  { key: 'pricingEmptyReturnPercent', title: 'Empty return trip', description: 'How much of the drive back a truck usually makes empty; its fuel is part of the trip cost.', label: 'Empty return (%)', helper: 'Allowed range: 0-100%. 0 means trucks always find a load back.', min: 0, max: 100 },
  { key: 'pricingTollAllowanceNgn', title: 'Toll allowance', description: 'Flat toll and route allowance included in every new quote.', label: 'Allowance (NGN)', helper: 'Allowed range: NGN 0-500,000 per shipment.', min: 0, max: 500_000 },
  { key: 'pricingDemandSurgePercent', title: 'Demand adjustment', description: 'Temporary network demand adjustment applied to new quotes.', label: 'Demand adjustment (%)', helper: 'Allowed range: 0-50%. Keep at 0 during normal demand.', min: 0, max: 50 },
  { key: 'pricingQuoteValidityMinutes', title: 'Quote validity', description: 'How long a customer quote remains valid before it must be recalculated.', label: 'Validity (minutes)', helper: 'Allowed range: 5-240 minutes.', min: 5, max: 240 },
  ...classes.flatMap(([prefix, name]) => [
    { key: `pricing${prefix}BaseFareNgn` as PricingSettingKey, title: `${name} base fare`, description: `Fixed part of a ${name.toLowerCase()} trip: getting to the pickup, loading and waiting.`, label: 'Base fare (NGN)', helper: 'Allowed range: NGN 0-2,000,000.', min: 0, max: 2_000_000 },
    { key: `pricing${prefix}OperatingPerKmNgn` as PricingSettingKey, title: `${name} running cost`, description: `Cost per km apart from fuel (driver pay, tyres, maintenance, insurance) for a ${name.toLowerCase()}.`, label: 'Running cost per km (NGN)', helper: 'Allowed range: NGN 0-10,000 per km.', min: 0, max: 10_000 },
    { key: `pricing${prefix}MinimumFareNgn` as PricingSettingKey, title: `${name} minimum fare`, description: `Least a ${name.toLowerCase()} trip pays the carrier, before Trako's commission.`, label: 'Minimum fare (NGN)', helper: 'Allowed range: NGN 0-2,000,000.', min: 0, max: 2_000_000 },
  ]),
];
