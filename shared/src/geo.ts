export interface Coordinates {
  lat: number;
  lng: number;
}

const NUMBER = "[-+]?\\d+(?:\\.\\d+)?";
// "12.97, 77.59", "12.97,77.59", "12.97 77.59" and "(12.97, 77.59)" are all accepted.
const COORDINATES = new RegExp(`^\\(?\\s*(${NUMBER})\\s*[,\\s]\\s*(${NUMBER})\\s*\\)?$`);

// Reads a location typed as latitude and longitude. Anything else (a zone name such as
// "Zone A", or numbers outside the valid ranges) is not a coordinate pair and gives null.
export function parseCoordinates(text: string): Coordinates | null {
  const m = COORDINATES.exec(text.trim());
  if (!m) return null;
  const lat = Number(m[1]);
  const lng = Number(m[2]);
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng };
}

const EARTH_RADIUS_KM = 6371;
const radians = (deg: number) => (deg * Math.PI) / 180;

// Great-circle distance between two points (haversine), in kilometres.
export function distanceKm(a: Coordinates, b: Coordinates): number {
  const dLat = radians(b.lat - a.lat);
  const dLng = radians(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(radians(a.lat)) * Math.cos(radians(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}
