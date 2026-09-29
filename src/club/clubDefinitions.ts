/** Club amenity keys — a fixed, axevo-curated checklist (not user-editable data). Mirrors the
 * achievements catalog pattern: gamification/definitions.ts's ACHIEVEMENT_KEYS is the server
 * source of truth, each client (FEXevo, the club dashboard) hardcodes its own labels/icons, and
 * a parity test (see clubAmenityCatalogParity.test.ts) catches drift between them. */
export const CLUB_AMENITY_KEYS = [
  "parking",
  "showers",
  "lockers",
  "pro_shop",
  "lighting",
  "air_conditioning",
  "restaurant_bar",
  "kids_area",
  "wifi",
  "equipment_rental",
  "wheelchair_accessible",
] as const;

export type ClubAmenityKey = (typeof CLUB_AMENITY_KEYS)[number];

const AMENITY_KEY_SET = new Set<string>(CLUB_AMENITY_KEYS);

export function isValidClubAmenityKey(key: string): key is ClubAmenityKey {
  return AMENITY_KEY_SET.has(key);
}

export const CLUB_COURT_INDOOR_OUTDOOR_VALUES = ["indoor", "outdoor", "covered"] as const;
export type ClubCourtIndoorOutdoor = (typeof CLUB_COURT_INDOOR_OUTDOOR_VALUES)[number];

export function isValidClubCourtIndoorOutdoor(
  value: string
): value is ClubCourtIndoorOutdoor {
  return (CLUB_COURT_INDOOR_OUTDOOR_VALUES as readonly string[]).includes(value);
}

export const CLUB_STATUS_VALUES = ["pending", "approved", "rejected"] as const;
export type ClubStatus = (typeof CLUB_STATUS_VALUES)[number];

/** URL-safe slug from a club name, e.g. "i95 Padel Club!" -> "i95-padel-club". Collisions are
 * resolved by the caller appending a short suffix before insert (slug has a unique DB index). */
export function slugifyClubName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}
