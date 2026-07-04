export interface PriceBreakdownItem {
  label: string;
  value: number;
}

export interface RidePricing {
  /** COE × zone coefficient (before liquidity margin). */
  baseFare: number;
  /** baseFare × liquidityMargin. */
  liquidityAmount: number;
  /** Taxa da plataforma (Taxa Cyborg). */
  platformFee: number;
  /** baseFare + liquidityAmount — value transferred to the driver. */
  driverNetAmount: number;
  /** driverNetAmount + platformFee — what the passenger pays. */
  totalPassengerPrice: number;
  distanceKm: number;
  estimatedDurationMin: number;
  pricingVersion: string;
  breakdown: PriceBreakdownItem[];
}
