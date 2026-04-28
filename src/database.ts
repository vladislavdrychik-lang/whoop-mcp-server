import Database from 'better-sqlite3';
import { encrypt, decrypt, isEncrypted } from './crypto.js';
import type {
  WhoopTokens,
  WhoopCycle,
  WhoopRecovery,
  WhoopSleep,
  WhoopWorkout,
  DbCycle,
  DbRecovery,
  DbSleep,
  DbWorkout,
} from './types.js';
import type { WithingsTokens, NormalisedBodyMeasurement } from './withings/withings-types.js';
import type { StravaTokens, NormalisedActivity } from './strava/strava-types.js';

interface TokenRow { id: number; access_token: string; refresh_token: string; expires_at: number; updated_at: string; }
interface SyncStateRow { id: number; last_sync_at: string | null; oldest_synced_date: string | null; newest_synced_date: string | null; }
interface RecoveryTrendRow { date: string; recovery_score: number; hrv: number; rhr: number; }
interface SleepTrendRow { date: string; total_sleep_hours: number; performance: number; efficiency: number; }
interface StrainTrendRow { date: string; strain: number; calories: number; }
interface HrZoneTrendRow { month: string; z0: number; z1: number; z2: number; z3: number; z4: number; z5: number; workout_count: number; total_strain: number; }
interface WithingsTokenRow { id: number; access_token: string; refresh_token: string; expires_at: number; user_id: number; scope: string | null; }
interface StravaTokenRow { id: number; access_token: string; refresh_token: string; expires_at: number; athlete_id: number; scope: string | null; }

export class WhoopDatabase {
  private db: Database.Database;

  constructor(dbPath = './whoop.db') {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tokens (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        access_token TEXT NOT NULL,
        refresh_token TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS sync_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        last_sync_at TEXT,
        oldest_synced_date TEXT,
        newest_synced_date TEXT
      );
      CREATE TABLE IF NOT EXISTS cycles (
        id INTEGER PRIMARY KEY,
        user_id INTEGER NOT NULL,
        start_time TEXT NOT NULL,
        end_time TEXT,
        score_state TEXT NOT NULL,
        strain REAL,
        kilojoule REAL,
        avg_hr INTEGER,
        max_hr INTEGER,
        synced_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS recovery (
        id INTEGER PRIMARY KEY,
        user_id INTEGER NOT NULL,
        sleep_id TEXT,
        created_at TEXT NOT NULL,
        score_state TEXT NOT NULL,
        recovery_score INTEGER,
        resting_hr INTEGER,
        hrv_rmssd REAL,
        spo2 REAL,
        skin_temp REAL,
        synced_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS sleep (
        id TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL,
        cycle_id INTEGER,
        start_time TEXT NOT NULL,
        end_time TEXT NOT NULL,
        is_nap INTEGER NOT NULL DEFAULT 0,
        score_state TEXT NOT NULL,
        total_in_bed_milli INTEGER,
        total_awake_milli INTEGER,
        total_light_milli INTEGER,
        total_deep_milli INTEGER,
        total_rem_milli INTEGER,
        sleep_performance REAL,
        sleep_efficiency REAL,
        sleep_consistency REAL,
        respiratory_rate REAL,
        sleep_needed_baseline_milli INTEGER,
        sleep_needed_debt_milli INTEGER,
        sleep_needed_strain_milli INTEGER,
        synced_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS workouts (
        id TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL,
        sport_id INTEGER NOT NULL,
        start_time TEXT NOT NULL,
        end_time TEXT NOT NULL,
        score_state TEXT NOT NULL,
        strain REAL,
        avg_hr INTEGER,
        max_hr INTEGER,
        kilojoule REAL,
        zone_zero_milli INTEGER,
        zone_one_milli INTEGER,
        zone_two_milli INTEGER,
        zone_three_milli INTEGER,
        zone_four_milli INTEGER,
        zone_five_milli INTEGER,
        synced_at TEXT DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS withings_tokens (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        access_token TEXT NOT NULL,
        refresh_token TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        scope TEXT
      );
      CREATE TABLE IF NOT EXISTS body_measurements (
        timestamp INTEGER PRIMARY KEY,
        date_iso TEXT NOT NULL,
        weight_kg REAL,
        fat_ratio_pct REAL,
        fat_mass_kg REAL,
        fat_free_mass_kg REAL,
        muscle_mass_kg REAL,
        bone_mass_kg REAL,
        hydration_kg REAL,
        visceral_fat REAL,
        height_m REAL,
        heart_rate INTEGER,
        device_id TEXT,
        timezone TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_body_date ON body_measurements(date_iso);

      CREATE TABLE IF NOT EXISTS strava_tokens (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        access_token TEXT NOT NULL,
        refresh_token TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        athlete_id INTEGER NOT NULL,
        scope TEXT
      );
      CREATE TABLE IF NOT EXISTS activities (
        strava_id INTEGER PRIMARY KEY,
        start_date TEXT NOT NULL,
        type TEXT NOT NULL,
        name TEXT,
        elapsed_min INTEGER,
        moving_min INTEGER,
        distance_km REAL,
        elevation_m REAL,
        avg_speed_kmh REAL,
        max_speed_kmh REAL,
        avg_hr INTEGER,
        max_hr INTEGER,
        avg_cadence REAL,
        avg_watts REAL,
        calories INTEGER,
        suffer_score INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_activities_date ON activities(start_date);

      CREATE INDEX IF NOT EXISTS idx_cycles_start ON cycles(start_time);
      CREATE INDEX IF NOT EXISTS idx_recovery_created ON recovery(created_at);
      CREATE INDEX IF NOT EXISTS idx_sleep_start ON sleep(start_time);
      CREATE INDEX IF NOT EXISTS idx_workouts_start ON workouts(start_time);
      INSERT OR IGNORE INTO sync_state (id) VALUES (1);
    `);
  }

  saveTokens(tokens: WhoopTokens): void {
    const encryptedAccess = encrypt(tokens.access_token);
    const encryptedRefresh = encrypt(tokens.refresh_token);
    this.db.prepare(`INSERT OR REPLACE INTO tokens (id, access_token, refresh_token, expires_at, updated_at) VALUES (1, ?, ?, ?, CURRENT_TIMESTAMP)`).run(encryptedAccess, encryptedRefresh, tokens.expires_at);
  }

  getTokens(): WhoopTokens | null {
    const row = this.db.prepare('SELECT * FROM tokens WHERE id = 1').get() as TokenRow | undefined;
    if (!row) return null;
    const accessToken = isEncrypted(row.access_token) ? decrypt(row.access_token) : row.access_token;
    const refreshToken = isEncrypted(row.refresh_token) ? decrypt(row.refresh_token) : row.refresh_token;
    return { access_token: accessToken, refresh_token: refreshToken, expires_at: row.expires_at };
  }

  saveWithingsTokens(tokens: WithingsTokens): void {
    const encA = encrypt(tokens.access_token);
    const encR = encrypt(tokens.refresh_token);
    this.db.prepare(`INSERT OR REPLACE INTO withings_tokens (id, access_token, refresh_token, expires_at, user_id, scope) VALUES (1, ?, ?, ?, ?, ?)`).run(encA, encR, tokens.expires_at, tokens.user_id, tokens.scope);
  }

  getWithingsTokens(): WithingsTokens | null {
    const row = this.db.prepare('SELECT * FROM withings_tokens WHERE id = 1').get() as WithingsTokenRow | undefined;
    if (!row) return null;
    const accessToken = isEncrypted(row.access_token) ? decrypt(row.access_token) : row.access_token;
    const refreshToken = isEncrypted(row.refresh_token) ? decrypt(row.refresh_token) : row.refresh_token;
    return { access_token: accessToken, refresh_token: refreshToken, expires_at: row.expires_at, user_id: row.user_id, scope: row.scope ?? '' };
  }

  upsertBodyMeasurements(rows: NormalisedBodyMeasurement[]): number {
    const stmt = this.db.prepare(`
      INSERT INTO body_measurements (timestamp, date_iso, weight_kg, fat_ratio_pct, fat_mass_kg, fat_free_mass_kg, muscle_mass_kg, bone_mass_kg, hydration_kg, visceral_fat, height_m, heart_rate, device_id, timezone)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(timestamp) DO UPDATE SET
        weight_kg = COALESCE(excluded.weight_kg, body_measurements.weight_kg),
        fat_ratio_pct = COALESCE(excluded.fat_ratio_pct, body_measurements.fat_ratio_pct),
        fat_mass_kg = COALESCE(excluded.fat_mass_kg, body_measurements.fat_mass_kg),
        fat_free_mass_kg = COALESCE(excluded.fat_free_mass_kg, body_measurements.fat_free_mass_kg),
        muscle_mass_kg = COALESCE(excluded.muscle_mass_kg, body_measurements.muscle_mass_kg),
        bone_mass_kg = COALESCE(excluded.bone_mass_kg, body_measurements.bone_mass_kg),
        hydration_kg = COALESCE(excluded.hydration_kg, body_measurements.hydration_kg),
        visceral_fat = COALESCE(excluded.visceral_fat, body_measurements.visceral_fat),
        height_m = COALESCE(excluded.height_m, body_measurements.height_m),
        heart_rate = COALESCE(excluded.heart_rate, body_measurements.heart_rate)
    `);
    const tx = this.db.transaction((items: NormalisedBodyMeasurement[]) => {
      let n = 0;
      for (const r of items) {
        stmt.run(r.timestamp, r.date_iso, r.weight_kg, r.fat_ratio_pct, r.fat_mass_kg, r.fat_free_mass_kg, r.muscle_mass_kg, r.bone_mass_kg, r.hydration_kg, r.visceral_fat, r.height_m, r.heart_rate, r.device_id, r.timezone);
        n++;
      }
      return n;
    });
    return tx(rows);
  }

  getLatestBodyMeasurementTimestamp(): number | null {
    const row = this.db.prepare('SELECT MAX(timestamp) as t FROM body_measurements').get() as { t: number | null } | undefined;
    return row?.t || null;
  }

  getBodyMeasurements(opts: { days?: number; limit?: number } = {}): NormalisedBodyMeasurement[] {
    const limit = opts.limit ?? 1000;
    if (opts.days) {
      const cutoff = Math.floor(Date.now() / 1000) - opts.days * 86400;
      return this.db.prepare(`SELECT * FROM body_measurements WHERE timestamp >= ? ORDER BY timestamp DESC LIMIT ?`).all(cutoff, limit) as NormalisedBodyMeasurement[];
    }
    return this.db.prepare(`SELECT * FROM body_measurements ORDER BY timestamp DESC LIMIT ?`).all(limit) as NormalisedBodyMeasurement[];
  }

  getSyncState(): { lastSyncAt: string | null; oldestDate: string | null; newestDate: string | null } {
    const row = this.db.prepare('SELECT * FROM sync_state WHERE id = 1').get() as SyncStateRow | undefined;
    return { lastSyncAt: row?.last_sync_at ?? null, oldestDate: row?.oldest_synced_date ?? null, newestDate: row?.newest_synced_date ?? null };
  }

  updateSyncState(oldestDate: string, newestDate: string): void {
    this.db.prepare(`UPDATE sync_state SET last_sync_at = CURRENT_TIMESTAMP, oldest_synced_date = COALESCE(CASE WHEN oldest_synced_date IS NULL OR ? < oldest_synced_date THEN ? ELSE oldest_synced_date END, ?), newest_synced_date = COALESCE(CASE WHEN newest_synced_date IS NULL OR ? > newest_synced_date THEN ? ELSE newest_synced_date END, ?) WHERE id = 1`).run(oldestDate, oldestDate, oldestDate, newestDate, newestDate, newestDate);
  }

  upsertCycles(cycles: WhoopCycle[]): void {
    const stmt = this.db.prepare(`INSERT OR REPLACE INTO cycles (id, user_id, start_time, end_time, score_state, strain, kilojoule, avg_hr, max_hr, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`);
    const insertMany = this.db.transaction((items: WhoopCycle[]) => { for (const c of items) { stmt.run(c.id, c.user_id, c.start, c.end, c.score_state, c.score?.strain ?? null, c.score?.kilojoule ?? null, c.score?.average_heart_rate ?? null, c.score?.max_heart_rate ?? null); } });
    insertMany(cycles);
  }

  upsertRecoveries(recoveries: WhoopRecovery[]): void {
    const stmt = this.db.prepare(`INSERT OR REPLACE INTO recovery (id, user_id, sleep_id, created_at, score_state, recovery_score, resting_hr, hrv_rmssd, spo2, skin_temp, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`);
    const insertMany = this.db.transaction((items: WhoopRecovery[]) => { for (const r of items) { stmt.run(r.cycle_id, r.user_id, r.sleep_id, r.created_at, r.score_state, r.score?.recovery_score ?? null, r.score?.resting_heart_rate ?? null, r.score?.hrv_rmssd_milli ?? null, r.score?.spo2_percentage ?? null, r.score?.skin_temp_celsius ?? null); } });
    insertMany(recoveries);
  }

  upsertSleeps(sleeps: WhoopSleep[]): void {
    const stmt = this.db.prepare(`INSERT OR REPLACE INTO sleep (id, user_id, start_time, end_time, is_nap, score_state, total_in_bed_milli, total_awake_milli, total_light_milli, total_deep_milli, total_rem_milli, sleep_performance, sleep_efficiency, sleep_consistency, respiratory_rate, sleep_needed_baseline_milli, sleep_needed_debt_milli, sleep_needed_strain_milli, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`);
    const insertMany = this.db.transaction((items: WhoopSleep[]) => { for (const s of items) { stmt.run(s.id, s.user_id, s.start, s.end, s.nap ? 1 : 0, s.score_state, s.score?.stage_summary?.total_in_bed_time_milli ?? null, s.score?.stage_summary?.total_awake_time_milli ?? null, s.score?.stage_summary?.total_light_sleep_time_milli ?? null, s.score?.stage_summary?.total_slow_wave_sleep_time_milli ?? null, s.score?.stage_summary?.total_rem_sleep_time_milli ?? null, s.score?.sleep_performance_percentage ?? null, s.score?.sleep_efficiency_percentage ?? null, s.score?.sleep_consistency_percentage ?? null, s.score?.respiratory_rate ?? null, s.score?.sleep_needed?.baseline_milli ?? null, s.score?.sleep_needed?.need_from_sleep_debt_milli ?? null, s.score?.sleep_needed?.need_from_recent_strain_milli ?? null); } });
    insertMany(sleeps);
  }

  upsertWorkouts(workouts: WhoopWorkout[]): void {
    const stmt = this.db.prepare(`INSERT OR REPLACE INTO workouts (id, user_id, sport_id, start_time, end_time, score_state, strain, avg_hr, max_hr, kilojoule, zone_zero_milli, zone_one_milli, zone_two_milli, zone_three_milli, zone_four_milli, zone_five_milli, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`);
    const insertMany = this.db.transaction((items: WhoopWorkout[]) => { for (const w of items) { stmt.run(w.id, w.user_id, w.sport_id, w.start, w.end, w.score_state, w.score?.strain ?? null, w.score?.average_heart_rate ?? null, w.score?.max_heart_rate ?? null, w.score?.kilojoule ?? null, w.score?.zone_durations?.zone_zero_milli ?? null, w.score?.zone_durations?.zone_one_milli ?? null, w.score?.zone_durations?.zone_two_milli ?? null, w.score?.zone_durations?.zone_three_milli ?? null, w.score?.zone_durations?.zone_four_milli ?? null, w.score?.zone_durations?.zone_five_milli ?? null); } });
    insertMany(workouts);
  }

  getLatestCycle(): DbCycle | null { return this.db.prepare('SELECT * FROM cycles ORDER BY start_time DESC LIMIT 1').get() as DbCycle | undefined ?? null; }
  getLatestRecovery(): DbRecovery | null { return this.db.prepare('SELECT * FROM recovery ORDER BY created_at DESC LIMIT 1').get() as DbRecovery | undefined ?? null; }
  getLatestSleep(): DbSleep | null { return this.db.prepare('SELECT * FROM sleep WHERE is_nap = 0 ORDER BY start_time DESC LIMIT 1').get() as DbSleep | undefined ?? null; }

  getCyclesByDateRange(startDate: string, endDate: string): DbCycle[] { return this.db.prepare(`SELECT * FROM cycles WHERE start_time >= ? AND start_time <= ? ORDER BY start_time DESC`).all(startDate, endDate) as DbCycle[]; }
  getRecoveriesByDateRange(startDate: string, endDate: string): DbRecovery[] { return this.db.prepare(`SELECT * FROM recovery WHERE created_at >= ? AND created_at <= ? ORDER BY created_at DESC`).all(startDate, endDate) as DbRecovery[]; }
  getSleepsByDateRange(startDate: string, endDate: string, includeNaps = false): DbSleep[] { const query = includeNaps ? 'SELECT * FROM sleep WHERE start_time >= ? AND start_time <= ? ORDER BY start_time DESC' : 'SELECT * FROM sleep WHERE start_time >= ? AND start_time <= ? AND is_nap = 0 ORDER BY start_time DESC'; return this.db.prepare(query).all(startDate, endDate) as DbSleep[]; }
  getWorkoutsByDateRange(startDate: string, endDate: string): DbWorkout[] { return this.db.prepare(`SELECT * FROM workouts WHERE start_time >= ? AND start_time <= ? ORDER BY start_time DESC`).all(startDate, endDate) as DbWorkout[]; }

  getRecoveryTrends(days: number): RecoveryTrendRow[] {
    return this.db.prepare(`SELECT DATE(created_at) as date, recovery_score, hrv_rmssd as hrv, resting_hr as rhr FROM recovery WHERE recovery_score IS NOT NULL AND created_at >= DATE('now', '-' || ? || ' days') ORDER BY created_at DESC`).all(days) as RecoveryTrendRow[];
  }

  getSleepTrends(days: number): SleepTrendRow[] {
    return this.db.prepare(`SELECT DATE(start_time) as date, ROUND((total_in_bed_milli - total_awake_milli) / 3600000.0, 2) as total_sleep_hours, sleep_performance as performance, sleep_efficiency as efficiency FROM sleep WHERE is_nap = 0 AND sleep_performance IS NOT NULL AND start_time >= DATE('now', '-' || ? || ' days') ORDER BY start_time DESC`).all(days) as SleepTrendRow[];
  }

  getStrainTrends(days: number): StrainTrendRow[] {
    return this.db.prepare(`SELECT DATE(start_time) as date, strain, ROUND(kilojoule / 4.184, 0) as calories FROM cycles WHERE strain IS NOT NULL AND start_time >= DATE('now', '-' || ? || ' days') ORDER BY start_time DESC`).all(days) as StrainTrendRow[];
  }

  getHrZoneTrends(days: number): HrZoneTrendRow[] {
    return this.db.prepare(`SELECT strftime('%Y-%m', start_time) as month, SUM(COALESCE(zone_zero_milli, 0)) as z0, SUM(COALESCE(zone_one_milli, 0)) as z1, SUM(COALESCE(zone_two_milli, 0)) as z2, SUM(COALESCE(zone_three_milli, 0)) as z3, SUM(COALESCE(zone_four_milli, 0)) as z4, SUM(COALESCE(zone_five_milli, 0)) as z5, COUNT(*) as workout_count, ROUND(SUM(COALESCE(strain, 0)), 1) as total_strain FROM workouts WHERE start_time >= DATE('now', '-' || ? || ' days') GROUP BY month ORDER BY month ASC`).all(days) as HrZoneTrendRow[];
  }


  saveStravaTokens(tokens: StravaTokens): void {
    const encA = encrypt(tokens.access_token);
    const encR = encrypt(tokens.refresh_token);
    this.db.prepare(`INSERT OR REPLACE INTO strava_tokens (id, access_token, refresh_token, expires_at, athlete_id, scope) VALUES (1, ?, ?, ?, ?, ?)`).run(encA, encR, tokens.expires_at, tokens.athlete_id, tokens.scope);
  }

  getStravaTokens(): StravaTokens | null {
    const row = this.db.prepare('SELECT * FROM strava_tokens WHERE id = 1').get() as StravaTokenRow | undefined;
    if (!row) return null;
    const accessToken = isEncrypted(row.access_token) ? decrypt(row.access_token) : row.access_token;
    const refreshToken = isEncrypted(row.refresh_token) ? decrypt(row.refresh_token) : row.refresh_token;
    return { access_token: accessToken, refresh_token: refreshToken, expires_at: row.expires_at, athlete_id: row.athlete_id, scope: row.scope ?? '' };
  }

  upsertActivities(rows: NormalisedActivity[]): number {
    const stmt = this.db.prepare(`INSERT INTO activities (strava_id, start_date, type, name, elapsed_min, moving_min, distance_km, elevation_m, avg_speed_kmh, max_speed_kmh, avg_hr, max_hr, avg_cadence, avg_watts, calories, suffer_score) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(strava_id) DO UPDATE SET name = excluded.name, type = excluded.type, distance_km = excluded.distance_km, elapsed_min = excluded.elapsed_min, moving_min = excluded.moving_min, elevation_m = excluded.elevation_m, avg_hr = excluded.avg_hr, max_hr = excluded.max_hr, avg_cadence = excluded.avg_cadence, avg_watts = excluded.avg_watts, calories = excluded.calories, suffer_score = excluded.suffer_score`);
    const tx = this.db.transaction((items: NormalisedActivity[]) => {
      let n = 0;
      for (const r of items) {
        stmt.run(r.strava_id, r.start_date, r.type, r.name, r.elapsed_min, r.moving_min, r.distance_km, r.elevation_m, r.avg_speed_kmh, r.max_speed_kmh, r.avg_hr, r.max_hr, r.avg_cadence, r.avg_watts, r.calories, r.suffer_score);
        n++;
      }
      return n;
    });
    return tx(rows);
  }

  getLatestActivityTimestamp(): number | null {
    const row = this.db.prepare(`SELECT MAX(strain_id_pseudo) as t FROM (SELECT strftime('%s', start_date) as strain_id_pseudo FROM activities)`).get() as { t: number | null } | undefined;
    return row?.t ? Number(row.t) : null;
  }

  getActivities(opts: { days?: number; limit?: number } = {}): NormalisedActivity[] {
    const limit = opts.limit ?? 100;
    if (opts.days) {
      const cutoff = new Date(Date.now() - opts.days * 86400 * 1000).toISOString().slice(0, 10);
      return this.db.prepare(`SELECT * FROM activities WHERE start_date >= ? ORDER BY start_date DESC LIMIT ?`).all(cutoff, limit) as NormalisedActivity[];
    }
    return this.db.prepare(`SELECT * FROM activities ORDER BY start_date DESC LIMIT ?`).all(limit) as NormalisedActivity[];
  }

  close(): void { this.db.close(); }
}
