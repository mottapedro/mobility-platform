import { Passenger, User } from "@prisma/client";
import { prisma } from "../../infra/prisma/client";
import { buildDriverPublicSlug } from "./DriverIdentityService";

export interface PassengerNetwork {
  level1: string[];
  level2: string[];
  level3: string[];
}

type PassengerWithUser = Passenger & { user: Pick<User, "name"> };

/**
 * Generates a referral code in the form "firstname-lastname-xxxx"
 * where xxxx is a 4-character alphanumeric random suffix.
 * Caller must persist the returned value to passenger.referralCode.
 */
export function generatePassengerReferralCode(passenger: PassengerWithUser): string {
  const slug = buildDriverPublicSlug(passenger.user.name);
  const suffix = Math.random().toString(36).slice(2, 6).padEnd(4, "0");
  return `${slug}-${suffix}`;
}

/**
 * Returns the Passenger record whose referralCode matches, or null.
 */
export async function resolvePassengerReferralCode(
  code: string,
  client: typeof prisma = prisma
): Promise<Passenger | null> {
  return client.passenger.findUnique({ where: { referralCode: code } });
}

/**
 * Throws an error (message includes "loop") when linking newId as a
 * referral of referrerId would create a circular chain.
 */
export async function validateNoLoop(
  newId: string,
  referrerId: string,
  client: typeof prisma = prisma
): Promise<void> {
  if (newId === referrerId) {
    throw new Error("Passenger referral loop detected: self-referral is not allowed");
  }

  const referrer = await client.passenger.findUnique({
    where: { id: referrerId },
    select: { lineagePath: true },
  });

  if (!referrer) return; // referrer not found — let FK validation handle it

  if (referrer.lineagePath.includes(newId)) {
    throw new Error(
      `Passenger referral loop detected: ${newId} already appears in referrer's lineage`
    );
  }
}

/**
 * Wires the referral relationship between newPassenger and referrerPassenger.
 * Sets: referredByPassengerId, networkLevel, rootPassengerId, lineagePath.
 * Validates no loop before writing.
 */
export async function createPassengerReferral(
  newPassengerId: string,
  referrerPassengerId: string,
  client: typeof prisma = prisma
): Promise<void> {
  await validateNoLoop(newPassengerId, referrerPassengerId, client);

  const referrer = await client.passenger.findUniqueOrThrow({
    where: { id: referrerPassengerId },
    select: { networkLevel: true, rootPassengerId: true, lineagePath: true },
  });

  const newNetworkLevel = referrer.networkLevel + 1;
  const newRootPassengerId = referrer.rootPassengerId ?? referrerPassengerId;

  // Seed the referrer's lineagePath if it is a root (never referred by anyone)
  let referrerLineage = referrer.lineagePath;
  if (referrerLineage.length === 0) {
    referrerLineage = [referrerPassengerId];
    await client.passenger.update({
      where: { id: referrerPassengerId },
      data: { lineagePath: referrerLineage },
    });
  }

  // Build the new passenger's lineagePath by appending its own ID
  const newLineagePath = [...referrerLineage, newPassengerId];

  await client.passenger.update({
    where: { id: newPassengerId },
    data: {
      referredByPassengerId: referrerPassengerId,
      networkLevel: newNetworkLevel,
      rootPassengerId: newRootPassengerId,
      lineagePath: newLineagePath,
    },
  });
}

/**
 * Returns the IDs of all passengers in the referral network of passengerId,
 * organized by level (up to 3 levels deep).
 * Three sequential DB reads — no join table needed.
 */
export async function getPassengerNetwork(
  passengerId: string,
  client: typeof prisma = prisma
): Promise<PassengerNetwork> {
  const level1Rows = await client.passenger.findMany({
    where: { referredByPassengerId: passengerId },
    select: { id: true },
  });
  const level1 = level1Rows.map((p) => p.id);

  if (level1.length === 0) return { level1: [], level2: [], level3: [] };

  const level2Rows = await client.passenger.findMany({
    where: { referredByPassengerId: { in: level1 } },
    select: { id: true },
  });
  const level2 = level2Rows.map((p) => p.id);

  if (level2.length === 0) return { level1, level2: [], level3: [] };

  const level3Rows = await client.passenger.findMany({
    where: { referredByPassengerId: { in: level2 } },
    select: { id: true },
  });
  const level3 = level3Rows.map((p) => p.id);

  return { level1, level2, level3 };
}

/**
 * Generates and persists a unique referralCode and publicSlug for a passenger.
 *
 * - publicSlug = normalized slug (e.g. "maria-silva"). On collision, appends
 *   an incrementing counter ("maria-silva-2", "maria-silva-3", …).
 * - referralCode = publicSlug + "-" + 4-char random suffix (always unique).
 * - Idempotent: if both fields are already set, returns existing values without
 *   touching the database.
 */
export async function assignPassengerIdentity(
  passengerId: string,
  userName: string,
  client: typeof prisma = prisma
): Promise<{ referralCode: string; publicSlug: string }> {
  // Check if this passenger already has a name-based identity.
  // Placeholder slugs (set at create time) always have publicSlug === referralCode.
  // After assignPassengerIdentity runs, publicSlug is the base slug and
  // referralCode is publicSlug + "-" + 4-char suffix, so they differ.
  const existing = await client.passenger.findUnique({
    where: { id: passengerId },
    select: { referralCode: true, publicSlug: true },
  });
  if (
    existing &&
    existing.referralCode &&
    existing.publicSlug &&
    existing.referralCode !== existing.publicSlug
  ) {
    return { referralCode: existing.referralCode, publicSlug: existing.publicSlug };
  }

  const baseSlug = buildDriverPublicSlug(userName);

  // Find a unique publicSlug (append counter on collision)
  let publicSlug = baseSlug;
  let counter = 1;
  while (
    await client.passenger.findFirst({
      where: { publicSlug, NOT: { id: passengerId } },
    })
  ) {
    publicSlug = `${baseSlug}-${++counter}`;
  }

  // Find a unique referralCode (retry random suffix on collision)
  let referralCode: string;
  do {
    const suffix = Math.random().toString(36).slice(2, 6).padEnd(4, "0");
    referralCode = `${publicSlug}-${suffix}`;
  } while (
    await client.passenger.findFirst({
      where: { referralCode, NOT: { id: passengerId } },
    })
  );

  await client.passenger.update({
    where: { id: passengerId },
    data: { publicSlug, referralCode },
  });

  return { referralCode, publicSlug };
}
