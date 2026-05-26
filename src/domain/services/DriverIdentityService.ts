import { Region } from "../../shared/enums";

const REGION_SUFFIX: Record<Region, string> = {
  ZN: "zn",
  ZS: "zs",
  ZO: "zo",
  BAIXADA: "baixada",
  INTER: "inter",
};

export function buildDriverPublicSlug(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function buildDriverReferralCode(publicSlug: string, regions: Region[]): string {
  const primaryRegion = regions[0];
  return primaryRegion ? `${publicSlug}-${REGION_SUFFIX[primaryRegion]}` : publicSlug;
}
