/**
 * Canonical re-export of every domain enum so application code never imports
 * directly from `@prisma/client`. This keeps the Prisma client at the
 * infrastructure boundary and lets us extend enums with TS-only lifecycle
 * mirrors (see ./transitions).
 *
 * Rule of thumb:
 *   - Enums (runtime + types) ............... import from "@/shared/enums"
 *   - Model row types (Driver, Ride, ...) ... import from "@prisma/client"
 *   - PrismaClient / Prisma namespace ....... import from "@prisma/client"
 */
export {
  ActorType,
  DomainEventType,
  DriverSkillCode,
  ExperienceLevel,
  OwnershipType,
  PaymentMethod,
  PaymentStatus,
  ReferralFlowType,
  Region,
  RideOfferStatus,
  RideStatus,
  SplitBeneficiaryType,
  UserRole,
  VehicleCategory,
} from "@prisma/client";

export {
  PaymentLifecycle,
  PAYMENT_LIFECYCLE_TRANSITIONS,
  RideLifecycle,
  RIDE_LIFECYCLE_TRANSITIONS,
  isValidPaymentTransition,
  isValidRideTransition,
} from "./transitions";
