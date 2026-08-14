import {
  seedRevenuePolicies,
  type RevenuePolicySeedClient,
} from "../../prisma/seeds/revenue-policy.seed";

interface RevenuePolicyFixtureClient extends RevenuePolicySeedClient {
  revenuePolicy: RevenuePolicySeedClient["revenuePolicy"] & {
    findUniqueOrThrow(args: {
      where: { code_version: { code: string; version: number } };
      select: { id: true };
    }): PromiseLike<{ id: string }>;
    deleteMany(args: {
      where: { code: string; version: number };
    }): PromiseLike<unknown>;
  };
}
type TestDataCleanup = () => Promise<void>;

export interface RevenuePolicyFixture {
  readonly policyId: string;
}

const STANDARD_POLICY_KEY = {
  code: "ROOT_DRIVER_STANDARD",
  version: 1,
} as const;

export async function installRevenuePolicyFixture(
  prisma: RevenuePolicyFixtureClient
): Promise<string> {
  await seedRevenuePolicies(prisma);

  const policy = await prisma.revenuePolicy.findUniqueOrThrow({
    where: { code_version: STANDARD_POLICY_KEY },
    select: { id: true },
  });

  return policy.id;
}

export async function removeRevenuePolicyFixture(
  prisma: RevenuePolicyFixtureClient
): Promise<void> {
  await prisma.revenuePolicy.deleteMany({
    where: STANDARD_POLICY_KEY,
  });
}

export function useRevenuePolicyFixture(
  prisma: RevenuePolicyFixtureClient,
  cleanTestData: TestDataCleanup
): RevenuePolicyFixture {
  let policyId: string | null = null;

  beforeEach(async () => {
    policyId = await installRevenuePolicyFixture(prisma);
  });

  afterEach(async () => {
    await cleanTestData();
    await removeRevenuePolicyFixture(prisma);
    policyId = null;
  });

  return {
    get policyId() {
      if (policyId === null) {
        throw new Error("RevenuePolicy fixture is not installed for the current test");
      }
      return policyId;
    },
  };
}
