import { ActorType, ReferralFlowType } from "../../shared/enums";
import { ReferralFlowError } from "./errors";

/**
 * Resolves the canonical ReferralFlowType from inviter/invited actor types.
 * Rejects invalid combinations (e.g. PASSENGER → DRIVER is not supported).
 */
export function resolveReferralFlowType(
  inviter: ActorType,
  invited: ActorType
): ReferralFlowType {
  if (inviter === ActorType.DRIVER && invited === ActorType.DRIVER) {
    return ReferralFlowType.DRIVER_TO_DRIVER;
  }
  if (inviter === ActorType.DRIVER && invited === ActorType.PASSENGER) {
    return ReferralFlowType.DRIVER_TO_PASSENGER;
  }
  if (inviter === ActorType.PASSENGER && invited === ActorType.PASSENGER) {
    return ReferralFlowType.PASSENGER_TO_PASSENGER;
  }
  throw new ReferralFlowError(
    `Unsupported referral flow: ${inviter} -> ${invited}`
  );
}
