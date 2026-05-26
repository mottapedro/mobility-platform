import {
  InMemoryPixProvider,
} from "../../src/domain/payment/providers/InMemoryPixProvider";

describe("InMemoryPixProvider", () => {
  it("createCharge returns a deterministic externalId based on intentId", async () => {
    const provider = new InMemoryPixProvider();
    const a = await provider.createCharge({ intentId: "pi-abc", amountCents: 1234 });
    const b = await provider.createCharge({ intentId: "pi-abc", amountCents: 1234 });
    expect(a.externalId).toBe(b.externalId);
    expect(a.externalId).toContain("pi-abc");
  });

  it("createCharge returns a non-empty qrCode and qrCodeImage", async () => {
    const provider = new InMemoryPixProvider();
    const r = await provider.createCharge({ intentId: "pi-1", amountCents: 5000 });
    expect(r.qrCode.length).toBeGreaterThan(0);
    expect(r.qrCodeImage.length).toBeGreaterThan(0);
  });

  it("encodes amountCents into the qrCode payload (auditability)", async () => {
    const provider = new InMemoryPixProvider();
    const r = await provider.createCharge({ intentId: "pi-2", amountCents: 7777 });
    expect(r.qrCode).toContain("7777");
  });

  it("getCharge returns the previously created charge by externalId", async () => {
    const provider = new InMemoryPixProvider();
    const r = await provider.createCharge({ intentId: "pi-3", amountCents: 999 });
    const found = provider.getCharge(r.externalId);
    expect(found).toBeDefined();
    expect(found?.amountCents).toBe(999);
    expect(found?.intentId).toBe("pi-3");
  });

  it("rejects non-positive amounts", async () => {
    const provider = new InMemoryPixProvider();
    await expect(
      provider.createCharge({ intentId: "x", amountCents: 0 })
    ).rejects.toThrow();
  });
});
