import { Region } from "../../shared/enums";
import { prisma } from "../../infra/prisma/client";

const REGION_BY_CODE: Record<string, Region> = {
  zn: Region.ZN,
  zs: Region.ZS,
  zo: Region.ZO,
  baixada: Region.BAIXADA,
  inter: Region.INTER,
};

function normalizeSlugPart(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function buildDriverNameVariants(name: string): Set<string> {
  const tokens = name
    .split(/\s+/)
    .map((token) => normalizeSlugPart(token))
    .filter(Boolean);

  const variants = new Set<string>();

  if (tokens.length === 0) {
    return variants;
  }

  variants.add(tokens.join("-"));
  variants.add(tokens[0]);

  if (tokens.length > 1) {
    variants.add(`${tokens[0]}-${tokens[tokens.length - 1]}`);
  }

  return variants;
}

function parseReferralCode(referralCode: string): {
  normalizedCode: string;
  baseCode: string;
  region: Region | null;
} {
  const normalizedCode = normalizeSlugPart(referralCode);
  const parts = normalizedCode.split("-").filter(Boolean);
  const maybeRegionCode = parts.length > 0 ? parts[parts.length - 1] : undefined;
  const region = maybeRegionCode ? REGION_BY_CODE[maybeRegionCode] ?? null : null;

  return {
    normalizedCode,
    baseCode: region ? parts.slice(0, -1).join("-") : normalizedCode,
    region,
  };
}

export async function resolveReferralCodeToDriverId(referralCode: string): Promise<string | null> {
  const { normalizedCode, baseCode, region } = parseReferralCode(referralCode);

  if (!normalizedCode || !baseCode) {
    return null;
  }

  const stored = await prisma.driver.findFirst({
    where: { isActive: true, referralCode: normalizedCode },
    select: { id: true },
  });

  if (stored) {
    return stored.id;
  }

  const drivers = await prisma.driver.findMany({
    where: { isActive: true },
    select: {
      id: true,
      regions: true,
      user: {
        select: { name: true },
      },
    },
  });

  const regionLabel = region ? Object.entries(REGION_BY_CODE).find(([, v]) => v === region)?.[0] : null;

  const matches = drivers.filter((driver) => {
    const variants = buildDriverNameVariants(driver.user.name);

    if (!variants.has(baseCode)) {
      return false;
    }

    if (!regionLabel) {
      return true;
    }

    return driver.regions.some((r) => normalizeSlugPart(r) === regionLabel);
  });

  if (matches.length !== 1) {
    return null;
  }

  return matches[0].id;
}   