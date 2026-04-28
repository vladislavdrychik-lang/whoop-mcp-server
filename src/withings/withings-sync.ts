import { WithingsClient } from './withings-client.js';
import type { WhoopDatabase } from '../database.js';

export class WithingsSync {
  constructor(private client: WithingsClient, private db: WhoopDatabase) {}

  async syncBodyMeasurements(): Promise<{ inserted: number; latest: number | null }> {
    const lastTs = this.db.getLatestBodyMeasurementTimestamp();
    const groups = await this.client.getMeasurements(
      lastTs ? { lastupdate: lastTs } : undefined
    );
    const rows = WithingsClient.normalise(groups);
    const inserted = this.db.upsertBodyMeasurements(rows);
    const latest = rows.length ? rows[0].timestamp : lastTs;
    return { inserted, latest };
  }
}
