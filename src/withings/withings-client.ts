import type {
  WithingsTokens,
  WithingsMeasureGroup,
  NormalisedBodyMeasurement,
} from './withings-types.js';
import { WITHINGS_MEASURE_TYPES as T } from './withings-types.js';

const WITHINGS_AUTH_URL = 'https://account.withings.com/oauth2_user/authorize2';
const WITHINGS_TOKEN_URL = 'https://wbsapi.withings.net/v2/oauth2';
const WITHINGS_API_URL = 'https://wbsapi.withings.net';

interface WithingsClientConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  onTokenRefresh?: (tokens: WithingsTokens) => void;
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

export class WithingsClient {
  private tokens: WithingsTokens | null = null;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly redirectUri: string;
  private readonly onTokenRefresh?: (tokens: WithingsTokens) => void;

  constructor(config: WithingsClientConfig) {
    this.clientId = config.clientId;
    this.clientSecret = config.clientSecret;
    this.redirectUri = config.redirectUri;
    this.onTokenRefresh = config.onTokenRefresh;
  }

  setTokens(tokens: WithingsTokens): void {
    this.tokens = tokens;
  }

  getAuthorizationUrl(scopes: string[] = ['user.metrics']): string {
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: this.clientId,
      state: crypto.randomUUID(),
      scope: scopes.join(','),
      redirect_uri: this.redirectUri,
    });
    return `${WITHINGS_AUTH_URL}?${params}`;
  }

  async exchangeCodeForTokens(code: string): Promise<WithingsTokens> {
    const body = new URLSearchParams({
      action: 'requesttoken',
      grant_type: 'authorization_code',
      client_id: this.clientId,
      client_secret: this.clientSecret,
      code,
      redirect_uri: this.redirectUri,
    });
    const response = await fetch(WITHINGS_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const json = await response.json() as {
      status: number;
      body?: { userid: string; access_token: string; refresh_token: string; expires_in: number; scope: string; token_type: string };
      error?: string;
    };
    if (json.status !== 0 || !json.body) {
      throw new Error(`Withings token exchange failed: ${JSON.stringify(json)}`);
    }
    const tokens: WithingsTokens = {
      access_token: json.body.access_token,
      refresh_token: json.body.refresh_token,
      expires_at: Date.now() + json.body.expires_in * 1000,
      user_id: parseInt(json.body.userid, 10),
      scope: json.body.scope,
    };
    this.tokens = tokens;
    return tokens;
  }

  private async refreshTokens(): Promise<void> {
    if (!this.tokens?.refresh_token) {
      throw new Error('No Withings refresh token available');
    }
    const body = new URLSearchParams({
      action: 'requesttoken',
      grant_type: 'refresh_token',
      client_id: this.clientId,
      client_secret: this.clientSecret,
      refresh_token: this.tokens.refresh_token,
    });
    const response = await fetch(WITHINGS_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const json = await response.json() as {
      status: number;
      body?: { userid: string; access_token: string; refresh_token: string; expires_in: number; scope: string };
    };
    if (json.status !== 0 || !json.body) {
      throw new Error(`Withings token refresh failed: ${JSON.stringify(json)}`);
    }
    this.tokens = {
      access_token: json.body.access_token,
      refresh_token: json.body.refresh_token,
      expires_at: Date.now() + json.body.expires_in * 1000,
      user_id: parseInt(json.body.userid, 10),
      scope: json.body.scope,
    };
    this.onTokenRefresh?.(this.tokens);
  }

  private async request<T>(path: string, params: Record<string, string>): Promise<T> {
    if (!this.tokens) throw new Error('Withings: not authenticated');
    if (this.tokens.expires_at - Date.now() < 5 * 60 * 1000) {
      await this.refreshTokens();
    }
    const body = new URLSearchParams(params);
    const maxRetries = 3;
    let lastError = '';
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const response = await fetch(`${WITHINGS_API_URL}${path}`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.tokens.access_token}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body,
      });
      if (response.ok) {
        const json = await response.json() as { status: number; body?: T; error?: string };
        if (json.status === 0 && json.body) return json.body;
        // Status 401 -> token expired
        if (json.status === 401 || json.status === 213) {
          await this.refreshTokens();
          continue;
        }
        lastError = `Withings API status=${json.status} error=${json.error || ''}`;
      } else {
        lastError = `${response.status} ${await response.text().catch(() => '')}`;
      }
      if (attempt < maxRetries - 1) await sleep(1000 * Math.pow(2, attempt));
    }
    throw new Error(`Withings request failed: ${lastError}`);
  }

  async getMeasurements(opts?: { startdate?: number; lastupdate?: number }): Promise<WithingsMeasureGroup[]> {
    const params: Record<string, string> = {
      action: 'getmeas',
      meastypes: [
        T.WEIGHT_KG, T.HEIGHT_M, T.FAT_FREE_MASS_KG, T.FAT_RATIO_PCT,
        T.FAT_MASS_KG, T.MUSCLE_MASS_KG, T.HYDRATION_KG, T.BONE_MASS_KG,
        T.VISCERAL_FAT, T.HEART_RATE_BPM,
      ].join(','),
      category: '1', // real measurements (not goals)
    };
    if (opts?.startdate) params.startdate = String(opts.startdate);
    if (opts?.lastupdate) params.lastupdate = String(opts.lastupdate);
    const result = await this.request<{ updatetime: number; timezone: string; measuregrps: WithingsMeasureGroup[] }>(
      '/measure',
      params,
    );
    return result.measuregrps || [];
  }

  // Convert raw measurement groups into flat normalised rows (one per timestamp)
  static normalise(groups: WithingsMeasureGroup[]): NormalisedBodyMeasurement[] {
    return groups.map(g => {
      const row: NormalisedBodyMeasurement = {
        timestamp: g.date,
        date_iso: new Date(g.date * 1000).toISOString().slice(0, 10),
        weight_kg: null, fat_ratio_pct: null, fat_mass_kg: null, fat_free_mass_kg: null,
        muscle_mass_kg: null, bone_mass_kg: null, hydration_kg: null, visceral_fat: null,
        height_m: null, heart_rate: null, device_id: g.deviceid, timezone: g.timezone,
      };
      for (const m of g.measures) {
        const val = m.value * Math.pow(10, m.unit);
        switch (m.type) {
          case T.WEIGHT_KG: row.weight_kg = val; break;
          case T.HEIGHT_M: row.height_m = val; break;
          case T.FAT_FREE_MASS_KG: row.fat_free_mass_kg = val; break;
          case T.FAT_RATIO_PCT: row.fat_ratio_pct = val; break;
          case T.FAT_MASS_KG: row.fat_mass_kg = val; break;
          case T.MUSCLE_MASS_KG: row.muscle_mass_kg = val; break;
          case T.HYDRATION_KG: row.hydration_kg = val; break;
          case T.BONE_MASS_KG: row.bone_mass_kg = val; break;
          case T.VISCERAL_FAT: row.visceral_fat = val; break;
          case T.HEART_RATE_BPM: row.heart_rate = val; break;
        }
      }
      return row;
    }).sort((a, b) => b.timestamp - a.timestamp);
  }
}
