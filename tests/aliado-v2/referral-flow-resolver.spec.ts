import { ActorType, ReferralFlowType } from "@prisma/client";
import { resolveReferralFlowType } from "../../src/domain/referral-network/ReferralFlowResolverService";
import { ReferralFlowError } from "../../src/domain/referral-network/errors";

describe("ReferralFlowResolverService", () => {
  it("maps DRIVER → DRIVER to DRIVER_TO_DRIVER", () => {
    expect(resolveReferralFlowType(ActorType.DRIVER, ActorType.DRIVER)).toBe(
      ReferralFlowType.DRIVER_TO_DRIVER
    );
  });

  it("maps DRIVER → PASSENGER to DRIVER_TO_PASSENGER", () => {
    expect(resolveReferralFlowType(ActorType.DRIVER, ActorType.PASSENGER)).toBe(
      ReferralFlowType.DRIVER_TO_PASSENGER
    );
  });

  it("maps PASSENGER → PASSENGER to PASSENGER_TO_PASSENGER", () => {
    expect(
      resolveReferralFlowType(ActorType.PASSENGER, ActorType.PASSENGER)
    ).toBe(ReferralFlowType.PASSENGER_TO_PASSENGER);
  });

  it("throws on PASSENGER → DRIVER (invalid)", () => {
    expect(() =>
      resolveReferralFlowType(ActorType.PASSENGER, ActorType.DRIVER)
    ).toThrow(ReferralFlowError);
  });
});
