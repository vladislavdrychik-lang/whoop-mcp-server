// Withings Public API types — Body Composition slice
// Reference: https://developer.withings.com/api-reference/

export interface WithingsTokens {
  access_token: string;
  refresh_token: string;
  expires_at: number; // Unix ms
  user_id: number;    // Withings user_id
  scope: string;
}

export interface WithingsMeasureGroup {
  grpid: number;
  attrib: number;
  date: number;       // Unix seconds (measurement timestamp)
  created: number;
  modified: number;
  category: number;   // 1 = real, 2 = goal
  deviceid: string | null;
  hash_deviceid: string | null;
  measures: WithingsMeasure[];
  comment: string | null;
  timezone: string;
}

export interface WithingsMeasure {
  value: number;       // raw value
  type: number;        // measurement type code
  unit: number;        // power-of-10 multiplier (-3 = milli, etc.)
  algo: number;
  fm: number;          // fat mass flag
}

// Measurement type codes (subset relevant for body composition)
export const WITHINGS_MEASURE_TYPES = {
  WEIGHT_KG: 1,
  HEIGHT_M: 4,
  FAT_FREE_MASS_KG: 5,
  FAT_RATIO_PCT: 6,
  FAT_MASS_KG: 8,
  HEART_RATE_BPM: 11,
  MUSCLE_MASS_KG: 76,
  HYDRATION_KG: 77,
  BONE_MASS_KG: 88,
  PULSE_WAVE_VELOCITY: 91,
  VO2MAX: 123,
  VISCERAL_FAT: 170, // dimensionless score
  BODY_TEMP_C: 71,
  SKIN_TEMP_C: 73,
} as const;

export interface NormalisedBodyMeasurement {
  timestamp: number;            // Unix seconds
  date_iso: string;             // YYYY-MM-DD
  weight_kg: number | null;
  fat_ratio_pct: number | null;
  fat_mass_kg: number | null;
  fat_free_mass_kg: number | null;
  muscle_mass_kg: number | null;
  bone_mass_kg: number | null;
  hydration_kg: number | null;
  visceral_fat: number | null;
  height_m: number | null;
  heart_rate: number | null;
  device_id: string | null;
  timezone: string;
}
