import { StravaClient } from './strava-client.js';
import type { WhoopDatabase } from '../database.js';

export class StravaSync {
  constructor(private client: StravaClient, private db: WhoopDatabase) {}

  async syncActivities(): Promise<{ inserted: number; latest: string | null }> {
    const lastTs = this.db.getLatestActivityTimestamp();
    const after = lastTs ? lastTs - 3600 : Math.floor(Date.now() / 1000) - 365 * 86400; // overlap 1h or last year
    const activities = await this.client.getAllActivitiesSince(after);
    const rows = StravaClient.normalise(activities);
    const inserted = this.db.upsertActivities(rows);
    const latest = rows.length ? rows[0].start_date : null;
    return { inserted, latest };
  }
}
