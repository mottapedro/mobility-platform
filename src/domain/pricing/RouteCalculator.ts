export interface Coordinates {
  lat: number;
  lng: number;
}

export interface RouteResult {
  distanceKm: number;
  estimatedDurationMin: number;
}

export interface RouteCalculator {
  calculate(from: Coordinates, to: Coordinates): Promise<RouteResult>;
}

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

const AVG_SPEED_KMH = 30;

export class HaversineRouteCalculator implements RouteCalculator {
  async calculate(from: Coordinates, to: Coordinates): Promise<RouteResult> {
    const distanceKm = Math.round(haversineKm(from.lat, from.lng, to.lat, to.lng) * 10) / 10;
    const estimatedDurationMin = Math.round((distanceKm / AVG_SPEED_KMH) * 60);
    return { distanceKm, estimatedDurationMin };
  }
}
