export interface PricingConfiguration {
  baseCostPerKm: number;
  platformFeeDefault: number;
  liquidityMarginNormal: number;
  liquidityMarginHigh: number;
  highScarcityThreshold: number;
  minimumFare: number;
  zoneCoefficients: { local: number; intercity: number };
  pricingVersion: string;
}

export const PRICING_CONFIG: PricingConfiguration = {
  baseCostPerKm: 1.20,
  platformFeeDefault: 2.50,
  liquidityMarginNormal: 0.20,
  liquidityMarginHigh: 0.55,
  highScarcityThreshold: 2,
  minimumFare: 5.00,
  zoneCoefficients: { local: 1.0, intercity: 2.0 },
  pricingVersion: "v1",
};
