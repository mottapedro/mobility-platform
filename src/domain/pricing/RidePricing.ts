export interface PriceBreakdownItem {
  label: string;
  value: number;
}

/**
 * ADR-001 §5 — Pricing Snapshot
 *
 * Immutable financial composition of a ride, produced once by PricingEngine
 * and persisted on RideRequest. Every field here maps 1:1 to a DB column.
 * No downstream component may recalculate these values.
 */
export interface RidePricing {
  // Route
  distanceKm: number;
  estimatedDurationMin: number;

  // Snapshot fields (ADR-001 §5)
  baseCOE: number;           // distanceKm × R$1,20/km (raw operational cost)
  zoneMultiplier: number;    // peso_esforco from OperationalZone
  liquidityMargin: number;   // 0.20 (normal) or 0.55 (scarcity)
  liquidityAmount: number;   // baseFare × liquidityMargin
  /** COE × zoneMultiplier — operational base fare before liquidity margin */
  baseFare: number;
  /** Value transferred to the driver = baseFare + liquidityAmount */
  driverNetAmount: number;
  /** Taxa Operacional Cyborg — fixed R$2,50 */
  platformFee: number;
  /** Total paid by passenger = driverNetAmount + platformFee (min R$5,00) */
  totalPassengerPrice: number;

  pricingVersion: string;
  breakdown: PriceBreakdownItem[];
}
