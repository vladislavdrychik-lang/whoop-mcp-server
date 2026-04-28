// Strava API types — Activities slice
// Reference: https://developers.strava.com/docs/reference/

export interface StravaTokens {
  access_token: string;
  refresh_token: string;
  expires_at: number;       // Unix seconds (Strava returns this format)
  athlete_id: number;
  scope: string;
}

export interface StravaActivity {
  id: number;
  name: string;
  type: string;             // e.g., 'Run', 'Ride', 'Swim', 'Workout', 'WeightTraining'
  sport_type: string;       // more granular: 'TrailRun', 'VirtualRide', etc.
  start_date_local: string; // ISO without TZ
  elapsed_time: number;     // seconds
  moving_time: number;      // seconds
  distance: number;         // meters
  total_elevation_gain: number; // meters
  average_speed: number;    // m/s
  max_speed: number;        // m/s
  average_heartrate?: number;
  max_heartrate?: number;
  has_heartrate: boolean;
  average_cadence?: number;
  average_watts?: number;
  kilojoules?: number;
  calories?: number;
  suffer_score?: number;    // Strava's relative effort
}

export interface NormalisedActivity {
  strava_id: number;
  start_date: string;       // YYYY-MM-DD
  type: string;
  name: string;
  elapsed_min: number;
  moving_min: number;
  distance_km: number;
  elevation_m: number;
  avg_speed_kmh: number | null;
  max_speed_kmh: number | null;
  avg_hr: number | null;
  max_hr: number | null;
  avg_cadence: number | null;
  avg_watts: number | null;
  calories: number | null;
  suffer_score: number | null;
}
