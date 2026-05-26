import { Region } from "../src/shared/enums";
import {
  buildDriverPublicSlug,
  buildDriverReferralCode,
} from "../src/domain/services/DriverIdentityService";

describe("DriverIdentityService", () => {
  it("builds a stable public slug from the driver name", () => {
    expect(buildDriverPublicSlug("João Luiz Correa de Brito")).toBe("joao-luiz-correa-de-brito");
  });

  it("builds a stable referral code using slug plus primary region", () => {
    expect(buildDriverReferralCode("joao-luiz-correa-de-brito", [Region.ZN])).toBe(
      "joao-luiz-correa-de-brito-zn"
    );
  });
});