/**
 * Anthropometric helpers for estimated absolute scale from profile stature / mass.
 * Primary motion units remain torso-normalized; these are labelled estimates only.
 */

/** Approx shoulder–hip torso length as a fraction of stature (adult mean). */
export const TORSO_FRACTION_OF_STATURE = 0.30;

/** Default padel racket mass when player gear is unknown (kg). */
export const DEFAULT_PADEL_RACKET_MASS_KG = 0.365;

/** Rough effective swinging mass fraction of body mass for arm+racket KE estimates. */
export const EFFECTIVE_SWING_MASS_FRACTION = 0.045;

export type AgeBand = "youth" | "adult" | "masters";

export type PlayerAnthropometrics = {
  heightCm?: number | null;
  weightKg?: number | null;
  birthDate?: string | null;
};

export type CourtCalibrationInput = {
  /** Metres per torso-unit at the player (when court/camera scale is known). */
  meters_per_torso_unit?: number | null;
  status?: "court_calibrated" | string | null;
};

export type CameraCalibrationStatus =
  | "uncalibrated_monocular"
  | "height_scaled_estimate"
  | "court_calibrated";

export function ageYearsFromBirthDate(
  birthDate: string | null | undefined,
  now = new Date()
): number | null {
  if (!birthDate || !/^\d{4}-\d{2}-\d{2}$/.test(birthDate)) return null;
  const [y, m, d] = birthDate.split("-").map(Number);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return null;
  let age = now.getUTCFullYear() - y;
  const md = now.getUTCMonth() + 1 - m;
  if (md < 0 || (md === 0 && now.getUTCDate() < d)) age -= 1;
  if (age < 0 || age > 120) return null;
  return age;
}

export function ageBandFromYears(age: number | null): AgeBand | null {
  if (age == null) return null;
  if (age < 18) return "youth";
  if (age >= 50) return "masters";
  return "adult";
}

export function parseCourtCalibration(
  metrics: Record<string, unknown> | null | undefined
): CourtCalibrationInput | null {
  if (!metrics || typeof metrics !== "object") return null;
  const raw = metrics.court_calibration;
  if (!raw || typeof raw !== "object") return null;
  const c = raw as Record<string, unknown>;
  const mptu = c.meters_per_torso_unit;
  const meters =
    typeof mptu === "number" && Number.isFinite(mptu) && mptu > 0 ? mptu : null;
  const status = typeof c.status === "string" ? c.status : null;
  if (meters == null && status == null) return null;
  return { meters_per_torso_unit: meters, status };
}

export function torsoMetersFromHeightCm(heightCm: number): number | null {
  if (!Number.isFinite(heightCm) || heightCm < 100 || heightCm > 250) return null;
  return (heightCm / 100) * TORSO_FRACTION_OF_STATURE;
}

export function resolveMetersPerTorsoUnit(opts: {
  heightCm?: number | null;
  court?: CourtCalibrationInput | null;
}): {
  metersPerTorso: number | null;
  status: CameraCalibrationStatus;
  method: "court_scale" | "height_torso_fraction" | null;
  uncertaintyPct: number | null;
} {
  const courtM = opts.court?.meters_per_torso_unit;
  if (
    courtM != null &&
    Number.isFinite(courtM) &&
    courtM > 0 &&
    (opts.court?.status === "court_calibrated" || opts.court?.status == null)
  ) {
    return {
      metersPerTorso: courtM,
      status: "court_calibrated",
      method: "court_scale",
      uncertaintyPct: 12,
    };
  }
  const torsoM =
    opts.heightCm != null ? torsoMetersFromHeightCm(opts.heightCm) : null;
  if (torsoM != null && torsoM > 0) {
    return {
      metersPerTorso: torsoM,
      status: "height_scaled_estimate",
      method: "height_torso_fraction",
      uncertaintyPct: 30,
    };
  }
  return {
    metersPerTorso: null,
    status: "uncalibrated_monocular",
    method: null,
    uncertaintyPct: null,
  };
}

export function bodySpeedToMps(
  bodyPerS: number | null | undefined,
  metersPerTorso: number | null
): number | null {
  if (
    bodyPerS == null ||
    !Number.isFinite(bodyPerS) ||
    bodyPerS <= 0 ||
    metersPerTorso == null ||
    metersPerTorso <= 0
  ) {
    return null;
  }
  return Math.round(bodyPerS * metersPerTorso * 100) / 100;
}

export function mpsToKmh(mps: number | null): number | null {
  if (mps == null || !Number.isFinite(mps)) return null;
  return Math.round(mps * 3.6 * 10) / 10;
}

/** Labelled kinetic-energy estimate from wrist peak speed + body mass. */
export function estimateSwingEnergyJ(opts: {
  wristPeakMps: number | null;
  weightKg: number | null;
  racketMassKg?: number;
}): { racket_ke_j_est: number | null; method: string; note: string } {
  const racketMass = opts.racketMassKg ?? DEFAULT_PADEL_RACKET_MASS_KG;
  const note =
    "Estimated from profile mass + wrist speed; not ground-reaction force. Label as estimated.";
  if (
    opts.wristPeakMps == null ||
    opts.wristPeakMps <= 0 ||
    opts.weightKg == null ||
    opts.weightKg < 30
  ) {
    return { racket_ke_j_est: null, method: "segment_mass_v1", note };
  }
  const mEff =
    opts.weightKg * EFFECTIVE_SWING_MASS_FRACTION + racketMass * 0.55;
  const ke = 0.5 * mEff * opts.wristPeakMps * opts.wristPeakMps;
  return {
    racket_ke_j_est: Math.round(ke * 10) / 10,
    method: "segment_mass_v1",
    note,
  };
}

export function ageCoachingNote(band: AgeBand | null): string | null {
  if (band === "youth") {
    return "Age band youth: prefer load-management language; avoid max-effort volume prescriptions.";
  }
  if (band === "masters") {
    return "Age band masters: emphasise recovery, warm-up, and joint-friendly progressions.";
  }
  if (band === "adult") {
    return "Age band adult: standard adult coaching norms.";
  }
  return null;
}
