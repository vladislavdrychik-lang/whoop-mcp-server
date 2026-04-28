import type { StravaTokens, StravaActivity, NormalisedActivity } from './strava-types.js';

const STRAVA_AUTH_URL = 'https://www.strava.com/oauth/authorize';
const STRAVA_TOKEN_URL = 'https://www.strava.com/oauth/token';
const STRAVA_API_URL = 'https://www.strava.com/api/v3';

interface StravaClientConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  onTokenRefresh?: (tokens: StravaTokens) => void;
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

export class StravaClient {
  private tokens: StravaTokens | null = null;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly redirectUri: string;
  private readonly onTokenRefresh?: (tokens: StravaTokens) => void;

  constructor(config: StravaClientConfig) {
    this.clientId = config.clientId;
    this.clientSecret = config.clientSecret;
    this.redirectUri = config.redirectUri;
    this.onTokenRefresh = config.onTokenRefresh;
  }

  setTokens(tokens: StravaTokens): void {
    this.tokens = tokens;
  }

  getAuthorizationUrl(scopes: string[] = ['read', 'activity:read_all', 'profile:read_all']): string {
    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      response_type: 'code',
      approval_prompt: 'auto',
      scope: scopes.join(','),
    });
    return `${STRAVA_AUTH_URL}?${params}`;
  }

  async exchangeCodeForTokens(code: string): Promise<StravaTokens> {
    const body = new URLSearchParams({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      code,
      grant_type: 'authorization_code',
    });
    const response = await fetch(STRAVA_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!response.ok) throw new Error(`Strava token exchange failed: ${await response.text()}`);
    const json = await response.json() as {
      access_token: string;
      refresh_token: string;
      expires_at: number;
      athlete: { id: number };
    };
    const tokens: StravaTokens = {
      access_token: json.access_token,
      refresh_token: json.refresh_token,
      expires_at: json.expires_at,
      athlete_id: json.athlete.id,
      scope: 'read,activity:read_all,profile:read_all',
    };
    this.tokens = tokens;
    return tokens;
  }

  private async refreshTokens(): Promise<void> {
    if (!this.tokens?.refresh_token) throw new Error('No Strava refresh token');
    const body = new URLSearchParams({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      grant_type: 'refresh_token',
      refresh_token: this.tokens.refresh_token,
    });
    const response = await fetch(STRAVA_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!response.ok) throw new Error(`Strava refresh failed: ${await response.text()}`);
    const json = await response.json() as { access_token: string; refresh_token: string; expires_at: number };
    this.tokens = {
      access_token: json.access_token,
      refresh_token: json.refresh_token,
      expires_at: json.expires_at,
      athlete_id: this.tokens.athlete_id,
      scope: this.tokens.scope,
    };
    this.onTokenRefresh?.(this.tokens);
  }

  private async request<T>(path: string, params?: Record<string, string>): Promise<T> {
    if (!this.tokens) throw new Error('Strava: not authenticated');
    const nowSec = Math.floor(Date.now() / 1000);
    if (this.tokens.expires_at - nowSec < 5 * 60) {
      await this.refreshTokens();
    }
    const url = new URL(`${STRAVA_API_URL}${path}`);
    if (params) {
      for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    }
    const maxRetries = 4;
    let lastError = '';
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const response = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${this.tokens.access_token}` },
      });
      if (response.ok) return response.json() as Promise<T>;
      lastError = `${response.status} ${await response.text().catch(() => '')}`;
      // 429 = rate limit (200/15min, 2000/day) — back off
      if (response.status === 429 && attempt < maxRetries - 1) {
        await sleep(60_000); // wait 1 min
        continue;
      }
      if (response.status === 401) {
        await this.refreshTokens();
        continue;
      }
      break;
    }
    throw new Error(`Strava request failed: ${lastError}`);
  }

  async getActivities(opts?: { after?: number; per_page?: number; page?: number }): Promise<StravaActivity[]> {
    const params: Record<string, string> = {
      per_page: String(opts?.per_page ?? 100),
      page: String(opts?.page ?? 1),
    };
    if (opts?.after) params.after = String(opts.after);
    return this.request<StravaActivity[]>('/athlete/activities', params);
  }

  async getAllActivitiesSince(afterTs: number): Promise<StravaActivity[]> {
    const all: StravaActivity[] = [];
    let page = 1;
    while (true) {
      const batch = await this.getActivities({ after: afterTs, per_page: 100, page });
      if (!batch.length) break;
      all.push(...batch);
      if (batch.length < 100) break;
      page++;
      await sleep(300);
    }
    return all;
  }

  static normalise(activities: StravaActivity[]): NormalisedActivity[] {
    return activities.map(a => ({
      strava_id: a.id,
      start_date: a.start_date_local.slice(0, 10),
      type: a.sport_type || a.type,
      name: a.name,
      elapsed_min: Math.round(a.elapsed_time / 60),
      moving_min: Math.round(a.moving_time / 60),
      distance_km: +(a.distance / 1000).toFixed(2),
      elevation_m: Math.round(a.total_elevation_gain),
      avg_speed_kmh: a.average_speed ? +(a.average_speed * 3.6).toFixed(2) : null,
      max_speed_kmh: a.max_speed ? +(a.max_speed * 3.6).toFixed(2) : null,
      avg_hr: a.average_heartrate ? Math.round(a.average_heartrate) : null,
      max_hr: a.max_heartrate ? Math.round(a.max_heartrate) : null,
      avg_cadence: a.average_cadence ? +a.average_cadence.toFixed(1) : null,
      avg_watts: a.average_watts ? Math.round(a.average_watts) : null,
      calories: a.calories ? Math.round(a.calories) : (a.kilojoules ? Math.round(a.kilojoules / 4.184) : null),
      suffer_score: a.suffer_score ?? null,
    })).sort((a, b) => b.start_date.localeCompare(a.start_date));
  }
}
