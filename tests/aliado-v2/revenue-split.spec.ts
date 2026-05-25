import { computeRevenueSplit } from "../../src/domain/payment/RevenueSplitService";

describe("RevenueSplitService.computeRevenueSplit", () => {
  it("splits 80% driver / 15% platform / 5% root when rootDriverId is set", () => {
    const r = computeRevenueSplit({ totalCents: 10_000, rootDriverId: "root-1" });
    expect(r.driverCents).toBe(8000);
    expect(r.platformCents).toBe(1500);
    expect(r.rootDriverCents).toBe(500);
    expect(r.rootDriverId).toBe("root-1");
  });

  it("rolls the 5% into platform when rootDriverId is null", () => {
    const r = computeRevenueSplit({ totalCents: 10_000, rootDriverId: null });
    expect(r.driverCents).toBe(8000);
    expect(r.platformCents).toBe(2000);
    expect(r.rootDriverCents).toBe(0);
    expect(r.rootDriverId).toBeNull();
  });

  it("preserves total cents under rounding (no money lost or invented)", () => {
    // 333 cents → 0.80*333=266.4 → 266 ; 0.15*333=49.95 → 49 ; remainder = 18
    const r = computeRevenueSplit({ totalCents: 333, rootDriverId: "root" });
    expect(r.driverCents + r.platformCents + r.rootDriverCents).toBe(333);
    expect(r.driverCents).toBe(266);
    expect(r.platformCents).toBe(49);
    expect(r.rootDriverCents).toBe(18);
  });

  it("rejects non-positive totals", () => {
    expect(() => computeRevenueSplit({ totalCents: 0, rootDriverId: null })).toThrow();
    expect(() => computeRevenueSplit({ totalCents: -1, rootDriverId: null })).toThrow();
  });

  it("rejects non-integer totals", () => {
    expect(() => computeRevenueSplit({ totalCents: 100.5, rootDriverId: null })).toThrow();
  });
});
