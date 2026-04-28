import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import express, { type Request, type Response } from 'express';
import { WhoopClient } from './whoop-client.js';
import { WhoopDatabase } from './database.js';
import { WhoopSync } from './sync.js';
import { WithingsClient } from './withings/withings-client.js';
import { WithingsSync } from './withings/withings-sync.js';
import { StravaClient } from './strava/strava-client.js';
import { StravaSync } from './strava/strava-sync.js';

interface ToolArguments { days?: number; full?: boolean; }

const config = {
  clientId: process.env.WHOOP_CLIENT_ID ?? '',
  clientSecret: process.env.WHOOP_CLIENT_SECRET ?? '',
  redirectUri: process.env.WHOOP_REDIRECT_URI ?? 'http://localhost:3000/callback',
  withingsClientId: process.env.WITHINGS_CLIENT_ID ?? '',
  withingsClientSecret: process.env.WITHINGS_CLIENT_SECRET ?? '',
  withingsRedirectUri: process.env.WITHINGS_REDIRECT_URI ?? 'http://localhost:3000/auth/withings/callback',
  stravaClientId: process.env.STRAVA_CLIENT_ID ?? '',
  stravaClientSecret: process.env.STRAVA_CLIENT_SECRET ?? '',
  stravaRedirectUri: process.env.STRAVA_REDIRECT_URI ?? 'http://localhost:3000/auth/strava/callback',
  dbPath: process.env.DB_PATH ?? './whoop.db',
  port: Number.parseInt(process.env.PORT ?? '3000', 10),
  mode: process.env.MCP_MODE ?? 'http',
};

const db = new WhoopDatabase(config.dbPath);
const client = new WhoopClient({
  clientId: config.clientId,
  clientSecret: config.clientSecret,
  redirectUri: config.redirectUri,
  onTokenRefresh: tokens => db.saveTokens(tokens),
});
const existingTokens = db.getTokens();
if (existingTokens) { client.setTokens(existingTokens); }
const sync = new WhoopSync(client, db);

const withingsClient = new WithingsClient({
  clientId: config.withingsClientId,
  clientSecret: config.withingsClientSecret,
  redirectUri: config.withingsRedirectUri,
  onTokenRefresh: tokens => db.saveWithingsTokens(tokens),
});
const existingWithingsTokens = db.getWithingsTokens();
if (existingWithingsTokens) { withingsClient.setTokens(existingWithingsTokens); }
const withingsSync = new WithingsSync(withingsClient, db);

const stravaClient = new StravaClient({
  clientId: config.stravaClientId,
  clientSecret: config.stravaClientSecret,
  redirectUri: config.stravaRedirectUri,
  onTokenRefresh: tokens => db.saveStravaTokens(tokens),
});
const existingStravaTokens = db.getStravaTokens();
if (existingStravaTokens) { stravaClient.setTokens(existingStravaTokens); }
const stravaSync = new StravaSync(stravaClient, db);

const SESSION_TTL_MS = 30 * 60 * 1000;
const transports = new Map<string, { transport: StreamableHTTPServerTransport; lastAccess: number }>();

function cleanupStaleSessions(): void {
  const now = Date.now();
  for (const [sessionId, session] of transports) {
    if (now - session.lastAccess > SESSION_TTL_MS) {
      session.transport.close().catch(() => {});
      transports.delete(sessionId);
    }
  }
}
setInterval(cleanupStaleSessions, 5 * 60 * 1000);

function formatDuration(millis: number | null): string {
  if (!millis) return 'N/A';
  const hours = Math.floor(millis / 3_600_000);
  const minutes = Math.floor((millis % 3_600_000) / 60_000);
  return `${hours}h ${minutes}m`;
}
function formatDate(isoString: string): string {
  return new Date(isoString).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}
function getRecoveryZone(score: number): string {
  if (score >= 67) return 'Green (Well Recovered)';
  if (score >= 34) return 'Yellow (Moderate)';
  return 'Red (Needs Rest)';
}
function getStrainZone(strain: number): string {
  if (strain >= 18) return 'All Out (18-21)';
  if (strain >= 14) return 'High (14-17)';
  if (strain >= 10) return 'Moderate (10-13)';
  return 'Light (0-9)';
}
function validateDays(value: unknown): number {
  if (value === undefined || value === null) return 14;
  const num = typeof value === 'number' ? value : Number.parseInt(String(value), 10);
  if (Number.isNaN(num) || num < 1) return 14;
  return Math.min(num, 3650);
}
function validateBoolean(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  return false;
}

function createMcpServer(): Server {
  const server = new Server({ name: 'whoop-mcp-server', version: '1.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      { name: 'get_today', description: "Get today's Whoop data including recovery score, last night's sleep, and current strain.", inputSchema: { type: 'object', properties: {}, required: [] } },
      { name: 'get_recovery_trends', description: 'Get recovery score trends over time, including HRV and resting heart rate patterns.', inputSchema: { type: 'object', properties: { days: { type: 'number', description: 'Number of days to analyze (default: 14, max: 3650)' } }, required: [] } },
      { name: 'get_sleep_analysis', description: 'Get detailed sleep analysis including duration, stages, efficiency, and sleep debt.', inputSchema: { type: 'object', properties: { days: { type: 'number', description: 'Number of days to analyze (default: 14, max: 3650)' } }, required: [] } },
      { name: 'get_strain_history', description: 'Get training strain history and workout data.', inputSchema: { type: 'object', properties: { days: { type: 'number', description: 'Number of days to analyze (default: 14, max: 3650)' } }, required: [] } },
      { name: 'get_hr_zones', description: 'Get monthly HR zone time distribution (Z0-Z5) from workouts. Critical for VO2max + Z2 base analysis.', inputSchema: { type: 'object', properties: { days: { type: 'number', description: 'Number of days to analyze (default: 90, max: 3650)' } }, required: [] } },
      { name: 'sync_data', description: 'Manually trigger a data sync from Whoop.', inputSchema: { type: 'object', properties: { full: { type: 'boolean', description: 'Force a full historical sync (default: false)' } }, required: [] } },
      { name: 'get_auth_url', description: 'Get the Whoop authorization URL to connect your account.', inputSchema: { type: 'object', properties: {}, required: [] } },
      { name: 'get_body_today', description: 'Get the latest Withings body composition measurement (weight, body fat %, muscle mass, bone, hydration, visceral fat).', inputSchema: { type: 'object', properties: {}, required: [] } },
      { name: 'get_body_trends', description: 'Get body composition history (weight, fat ratio, muscle mass, etc.) from Withings over the last N days.', inputSchema: { type: 'object', properties: { days: { type: 'number', description: 'Number of days to analyze (default: 90, max: 3650)' } }, required: [] } },
      { name: 'sync_withings', description: 'Force sync with Withings API to import new body composition measurements.', inputSchema: { type: 'object', properties: {}, required: [] } },
      { name: 'get_withings_auth_url', description: 'Get the Withings authorization URL to connect your account (one-time setup).', inputSchema: { type: 'object', properties: {}, required: [] } },
      { name: 'get_activities', description: 'Get recent training activities from Strava (Garmin syncs there). Includes pace, distance, HR, cadence.', inputSchema: { type: 'object', properties: { days: { type: 'number', description: 'Number of days back (default 30, max 3650)' } }, required: [] } },
      { name: 'sync_strava', description: 'Force sync with Strava API to import new activities from Garmin.', inputSchema: { type: 'object', properties: {}, required: [] } },
      { name: 'get_strava_auth_url', description: 'Get the Strava authorization URL to connect your account (one-time setup).', inputSchema: { type: 'object', properties: {}, required: [] } },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async request => {
    const { name, arguments: args } = request.params;
    const typedArgs = (args ?? {}) as ToolArguments;
    try {
      const dataTools = ['get_today', 'get_recovery_trends', 'get_sleep_analysis', 'get_strain_history', 'get_hr_zones'];
      if (dataTools.includes(name)) {
        const tokens = db.getTokens();
        if (!tokens) {
          return { content: [{ type: 'text', text: 'Not authenticated with Whoop. Use get_auth_url to authorize first.' }] };
        }
        client.setTokens(tokens);
        try { await sync.smartSync(); } catch { /* continue with cached data */ }
      }

      switch (name) {
        case 'get_today': {
          const recovery = db.getLatestRecovery();
          const sleep = db.getLatestSleep();
          const cycle = db.getLatestCycle();
          if (!recovery && !sleep && !cycle) return { content: [{ type: 'text', text: 'No data available. Try running sync_data first.' }] };
          let response = "# Today's Whoop Summary\n\n";
          if (recovery) {
            response += `## Recovery: ${recovery.recovery_score ?? 'N/A'}% ${recovery.recovery_score ? getRecoveryZone(recovery.recovery_score) : ''}\n`;
            response += `- **HRV**: ${recovery.hrv_rmssd?.toFixed(1) ?? 'N/A'} ms\n`;
            response += `- **Resting HR**: ${recovery.resting_hr ?? 'N/A'} bpm\n`;
            if (recovery.spo2) response += `- **SpO2**: ${recovery.spo2.toFixed(1)}%\n`;
            if (recovery.skin_temp) response += `- **Skin Temp**: ${recovery.skin_temp.toFixed(1)}°C\n`;
            response += '\n';
          }
          if (sleep) {
            const totalSleep = (sleep.total_in_bed_milli ?? 0) - (sleep.total_awake_milli ?? 0);
            response += `## Last Night's Sleep\n- **Total Sleep**: ${formatDuration(totalSleep)}\n- **Performance**: ${sleep.sleep_performance?.toFixed(0) ?? 'N/A'}%\n- **Efficiency**: ${sleep.sleep_efficiency?.toFixed(0) ?? 'N/A'}%\n- **Stages**: Light ${formatDuration(sleep.total_light_milli)}, Deep ${formatDuration(sleep.total_deep_milli)}, REM ${formatDuration(sleep.total_rem_milli)}\n`;
            if (sleep.respiratory_rate) response += `- **Respiratory Rate**: ${sleep.respiratory_rate.toFixed(1)} breaths/min\n`;
            response += '\n';
          }
          if (cycle) {
            response += `## Current Strain\n- **Day Strain**: ${cycle.strain?.toFixed(1) ?? 'N/A'} ${cycle.strain ? getStrainZone(cycle.strain) : ''}\n`;
            if (cycle.kilojoule) response += `- **Calories**: ${Math.round(cycle.kilojoule / 4.184)} kcal\n`;
            if (cycle.avg_hr) response += `- **Avg HR**: ${cycle.avg_hr} bpm\n`;
            if (cycle.max_hr) response += `- **Max HR**: ${cycle.max_hr} bpm\n`;
          }
          return { content: [{ type: 'text', text: response }] };
        }
        case 'get_recovery_trends': {
          const days = validateDays(typedArgs.days);
          const trends = db.getRecoveryTrends(days);
          if (trends.length === 0) return { content: [{ type: 'text', text: 'No recovery data available for the requested period.' }] };
          let response = `# Recovery Trends (Last ${days} Days)\n\n| Date | Recovery | HRV | RHR |\n|------|----------|-----|-----|\n`;
          for (const day of trends) response += `| ${formatDate(day.date)} | ${day.recovery_score}% | ${day.hrv?.toFixed(1) ?? 'N/A'} ms | ${day.rhr ?? 'N/A'} bpm |\n`;
          const avgRecovery = trends.reduce((s, d) => s + (d.recovery_score || 0), 0) / trends.length;
          const avgHrv = trends.reduce((s, d) => s + (d.hrv || 0), 0) / trends.length;
          const avgRhr = trends.reduce((s, d) => s + (d.rhr || 0), 0) / trends.length;
          response += `\n## Averages\n- **Recovery**: ${avgRecovery.toFixed(0)}%\n- **HRV**: ${avgHrv.toFixed(1)} ms\n- **RHR**: ${avgRhr.toFixed(0)} bpm\n`;
          return { content: [{ type: 'text', text: response }] };
        }
        case 'get_sleep_analysis': {
          const days = validateDays(typedArgs.days);
          const trends = db.getSleepTrends(days);
          if (trends.length === 0) return { content: [{ type: 'text', text: 'No sleep data available for the requested period.' }] };
          let response = `# Sleep Analysis (Last ${days} Days)\n\n| Date | Duration | Performance | Efficiency |\n|------|----------|-------------|------------|\n`;
          for (const day of trends) response += `| ${formatDate(day.date)} | ${day.total_sleep_hours?.toFixed(1) ?? 'N/A'}h | ${day.performance?.toFixed(0) ?? 'N/A'}% | ${day.efficiency?.toFixed(0) ?? 'N/A'}% |\n`;
          const avgDuration = trends.reduce((s, d) => s + (d.total_sleep_hours || 0), 0) / trends.length;
          const avgPerf = trends.reduce((s, d) => s + (d.performance || 0), 0) / trends.length;
          const avgEff = trends.reduce((s, d) => s + (d.efficiency || 0), 0) / trends.length;
          response += `\n## Averages\n- **Duration**: ${avgDuration.toFixed(1)} hours\n- **Performance**: ${avgPerf.toFixed(0)}%\n- **Efficiency**: ${avgEff.toFixed(0)}%\n`;
          return { content: [{ type: 'text', text: response }] };
        }
        case 'get_strain_history': {
          const days = validateDays(typedArgs.days);
          const trends = db.getStrainTrends(days);
          if (trends.length === 0) return { content: [{ type: 'text', text: 'No strain data available for the requested period.' }] };
          let response = `# Strain History (Last ${days} Days)\n\n| Date | Strain | Calories |\n|------|--------|----------|\n`;
          for (const day of trends) response += `| ${formatDate(day.date)} | ${day.strain?.toFixed(1) ?? 'N/A'} | ${day.calories ?? 'N/A'} kcal |\n`;
          const avgStrain = trends.reduce((s, d) => s + (d.strain || 0), 0) / trends.length;
          const avgCalories = trends.reduce((s, d) => s + (d.calories || 0), 0) / trends.length;
          response += `\n## Averages\n- **Daily Strain**: ${avgStrain.toFixed(1)}\n- **Daily Calories**: ${Math.round(avgCalories)} kcal\n`;
          return { content: [{ type: 'text', text: response }] };
        }
        case 'get_hr_zones': {
          const days = validateDays(typedArgs.days);
          const trends = db.getHrZoneTrends(days);
          if (trends.length === 0) return { content: [{ type: 'text', text: 'No workout HR zone data available.' }] };
          let response = `# HR Zone Distribution (Last ${days} Days)\n\nMonthly time spent in each heart rate zone (from workouts):\n\n| Month | Z0 | Z1 | Z2 | Z3 | Z4 | Z5 | Workouts | Strain |\n|-------|----|----|----|----|----|----|----|----|\n`;
          for (const m of trends) response += `| ${m.month} | ${formatDuration(m.z0)} | ${formatDuration(m.z1)} | ${formatDuration(m.z2)} | ${formatDuration(m.z3)} | ${formatDuration(m.z4)} | ${formatDuration(m.z5)} | ${m.workout_count} | ${m.total_strain} |\n`;
          const totals = trends.reduce((acc, m) => ({ z0: acc.z0 + (m.z0 || 0), z1: acc.z1 + (m.z1 || 0), z2: acc.z2 + (m.z2 || 0), z3: acc.z3 + (m.z3 || 0), z4: acc.z4 + (m.z4 || 0), z5: acc.z5 + (m.z5 || 0), workouts: acc.workouts + (m.workout_count || 0) }), { z0:0, z1:0, z2:0, z3:0, z4:0, z5:0, workouts:0 });
          const total = totals.z0 + totals.z1 + totals.z2 + totals.z3 + totals.z4 + totals.z5;
          const pct = (v: number) => total ? Math.round(v / total * 100) : 0;
          response += `\n## Totals across period\n- **Z0**: ${formatDuration(totals.z0)} (${pct(totals.z0)}%)\n- **Z1**: ${formatDuration(totals.z1)} (${pct(totals.z1)}%)\n- **Z2**: ${formatDuration(totals.z2)} (${pct(totals.z2)}%)\n- **Z3**: ${formatDuration(totals.z3)} (${pct(totals.z3)}%)\n- **Z4**: ${formatDuration(totals.z4)} (${pct(totals.z4)}%)\n- **Z5**: ${formatDuration(totals.z5)} (${pct(totals.z5)}%)\n- **Total workouts**: ${totals.workouts}\n- **Total tracked time**: ${formatDuration(total)}\n`;
          return { content: [{ type: 'text', text: response }] };
        }
        case 'sync_data': {
          const tokens = db.getTokens();
          if (!tokens) return { content: [{ type: 'text', text: 'Not authenticated with Whoop. Use get_auth_url to authorize first.' }] };
          client.setTokens(tokens);
          const full = validateBoolean(typedArgs.full);
          let stats;
          if (full) { stats = await sync.syncDays(3650); }
          else {
            const result = await sync.smartSync();
            if (result.type === 'skip') return { content: [{ type: 'text', text: 'Data is already up to date (synced within the last hour).' }] };
            stats = result.stats;
          }
          return { content: [{ type: 'text', text: `Sync complete!\n- Cycles: ${stats?.cycles}\n- Recoveries: ${stats?.recoveries}\n- Sleeps: ${stats?.sleeps}\n- Workouts: ${stats?.workouts}` }] };
        }
        case 'get_auth_url': {
          const scopes = ['read:profile', 'read:body_measurement', 'read:cycles', 'read:recovery', 'read:sleep', 'read:workout', 'offline'];
          const url = client.getAuthorizationUrl(scopes);
          return { content: [{ type: 'text', text: `To authorize with Whoop:\n\n1. Visit: ${url}\n2. Log in and authorize\n3. You'll be redirected back automatically\n\nRedirect URI: ${config.redirectUri}` }] };
        }
        case 'get_body_today': {
          const tokens = db.getWithingsTokens();
          if (!tokens) return { content: [{ type: 'text', text: 'Not authenticated with Withings. Use get_withings_auth_url to authorize first.' }] };
          withingsClient.setTokens(tokens);
          try { await withingsSync.syncBodyMeasurements(); } catch { /* fallback to cache */ }
          const rows = db.getBodyMeasurements({ limit: 1 });
          if (!rows.length) return { content: [{ type: 'text', text: 'No Withings measurements yet.' }] };
          const r = rows[0];
          const text = `# Latest Body Composition (${r.date_iso})\n\n- **Weight**: ${r.weight_kg?.toFixed(1) ?? 'N/A'} kg\n- **Body Fat**: ${r.fat_ratio_pct?.toFixed(1) ?? 'N/A'} %\n- **Fat Mass**: ${r.fat_mass_kg?.toFixed(1) ?? 'N/A'} kg\n- **Muscle Mass**: ${r.muscle_mass_kg?.toFixed(1) ?? 'N/A'} kg\n- **Bone Mass**: ${r.bone_mass_kg?.toFixed(1) ?? 'N/A'} kg\n- **Hydration**: ${r.hydration_kg?.toFixed(1) ?? 'N/A'} kg\n- **Visceral Fat**: ${r.visceral_fat?.toFixed(1) ?? 'N/A'}\n- **Height**: ${r.height_m?.toFixed(2) ?? 'N/A'} m\n- **Device**: ${r.device_id || 'manual'}`;
          return { content: [{ type: 'text', text }] };
        }
        case 'get_body_trends': {
          const tokens = db.getWithingsTokens();
          if (!tokens) return { content: [{ type: 'text', text: 'Not authenticated with Withings. Use get_withings_auth_url to authorize first.' }] };
          withingsClient.setTokens(tokens);
          try { await withingsSync.syncBodyMeasurements(); } catch { /* fallback */ }
          const days = Math.min(typedArgs.days || 90, 3650);
          const rows = db.getBodyMeasurements({ days });
          if (!rows.length) return { content: [{ type: 'text', text: 'No measurements in window.' }] };
          const lines = [`# Body Composition Trends (Last ${days} Days)`, '', '| Date | Weight (kg) | Fat % | Muscle (kg) | Bone (kg) | Visceral |', '|------|-------------|-------|-------------|-----------|----------|'];
          for (const r of rows) lines.push(`| ${r.date_iso} | ${r.weight_kg?.toFixed(1) ?? '-'} | ${r.fat_ratio_pct?.toFixed(1) ?? '-'} | ${r.muscle_mass_kg?.toFixed(1) ?? '-'} | ${r.bone_mass_kg?.toFixed(1) ?? '-'} | ${r.visceral_fat?.toFixed(1) ?? '-'} |`);
          const wts = rows.map(r => r.weight_kg).filter((v): v is number => v != null);
          const bfs = rows.map(r => r.fat_ratio_pct).filter((v): v is number => v != null);
          const mus = rows.map(r => r.muscle_mass_kg).filter((v): v is number => v != null);
          if (wts.length) lines.push('', '## Averages', `- **Weight**: ${(wts.reduce((s,v)=>s+v,0)/wts.length).toFixed(1)} kg`, `- **Body Fat**: ${(bfs.reduce((s,v)=>s+v,0)/Math.max(bfs.length,1)).toFixed(1)} %`, `- **Muscle Mass**: ${(mus.reduce((s,v)=>s+v,0)/Math.max(mus.length,1)).toFixed(1)} kg`);
          return { content: [{ type: 'text', text: lines.join('\n') }] };
        }
        case 'sync_withings': {
          const tokens = db.getWithingsTokens();
          if (!tokens) return { content: [{ type: 'text', text: 'Not authenticated with Withings. Use get_withings_auth_url first.' }] };
          withingsClient.setTokens(tokens);
          const result = await withingsSync.syncBodyMeasurements();
          return { content: [{ type: 'text', text: `Withings sync OK: ${result.inserted} measurements upserted. Latest: ${result.latest ? new Date(result.latest * 1000).toISOString() : 'n/a'}.` }] };
        }
        case 'get_withings_auth_url': {
          const url = withingsClient.getAuthorizationUrl(['user.metrics']);
          return { content: [{ type: 'text', text: `To authorize with Withings:\n\n1. Visit: ${url}\n2. Log in and authorize\n3. Redirect: ${config.withingsRedirectUri}\n\n(One-time setup; tokens auto-refresh after.)` }] };
        }
        case 'get_activities': {
          const tokens = db.getStravaTokens();
          if (!tokens) return { content: [{ type: 'text', text: 'Not authenticated with Strava. Use get_strava_auth_url to authorize first.' }] };
          stravaClient.setTokens(tokens);
          try { await stravaSync.syncActivities(); } catch { /* fallback */ }
          const days = Math.min(typedArgs.days || 30, 3650);
          const rows = db.getActivities({ days });
          if (!rows.length) return { content: [{ type: 'text', text: 'No activities found.' }] };
          const lines = [`# Strava Activities (Last ${days} Days)`, '', '| Date | Type | Name | Distance | Time | Pace | Avg HR | Elev |', '|------|------|------|----------|------|------|--------|------|'];
          for (const a of rows.slice(0, 50)) {
            const paceStr = a.distance_km > 0 && a.moving_min > 0 ? `${(a.moving_min / a.distance_km).toFixed(2)} min/km` : '-';
            lines.push(`| ${a.start_date} | ${a.type} | ${a.name} | ${a.distance_km}km | ${a.moving_min}min | ${paceStr} | ${a.avg_hr ?? '-'} | ${a.elevation_m ?? '-'}m |`);
          }
          return { content: [{ type: 'text', text: lines.join('\n') }] };
        }
        case 'sync_strava': {
          const tokens = db.getStravaTokens();
          if (!tokens) return { content: [{ type: 'text', text: 'Not authenticated with Strava. Use get_strava_auth_url first.' }] };
          stravaClient.setTokens(tokens);
          const result = await stravaSync.syncActivities();
          return { content: [{ type: 'text', text: `Strava sync OK: ${result.inserted} activities upserted. Latest: ${result.latest || 'n/a'}.` }] };
        }
        case 'get_strava_auth_url': {
          const url = stravaClient.getAuthorizationUrl(['read', 'activity:read_all', 'profile:read_all']);
          return { content: [{ type: 'text', text: `To authorize with Strava:\n\n1. Visit: ${url}\n2. Approve scopes\n3. Redirect: ${config.stravaRedirectUri}\n\n(One-time setup; tokens auto-refresh.)` }] };
        }
        default: throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
    }
  });

  return server;
}

async function main(): Promise<void> {
  if (config.mode === 'stdio') {
    const server = createMcpServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    process.stderr.write('Whoop MCP server running on stdio\n');
  } else {
    const app = express();

    app.get('/callback', async (req: Request, res: Response) => {
      const code = req.query.code as string | undefined;
      if (!code) { res.status(400).send('Missing authorization code'); return; }
      try {
        const tokens = await client.exchangeCodeForTokens(code);
        db.saveTokens(tokens);
        sync.syncDays(90).catch(() => {});
        res.send('Authorization successful! You can close this window.');
      } catch {
        res.status(500).send('Authorization failed. Please try again.');
      }
    });

    app.get('/auth/withings/login', (_req: Request, res: Response) => {
      const url = withingsClient.getAuthorizationUrl(['user.metrics']);
      res.redirect(url);
    });
    app.get('/auth/withings/callback', async (req: Request, res: Response) => {
      const code = req.query.code as string | undefined;
      if (!code) { res.status(400).send('Missing authorization code'); return; }
      try {
        const tokens = await withingsClient.exchangeCodeForTokens(code);
        db.saveWithingsTokens(tokens);
        const result = await withingsSync.syncBodyMeasurements();
        res.send(`<html><body style="font-family:sans-serif;padding:24px;"><h2>Withings connected ✓</h2><p>User ID: ${tokens.user_id}</p><p>Initial sync: ${result.inserted} measurements imported.</p><p>Latest: ${result.latest ? new Date(result.latest * 1000).toLocaleString() : 'n/a'}</p><p>You can close this tab.</p></body></html>`);
      } catch (e: any) {
        res.status(500).send(`Withings auth failed: ${e.message}`);
      }
    });

    app.get('/auth/strava/login', (_req: Request, res: Response) => {
      const url = stravaClient.getAuthorizationUrl();
      res.redirect(url);
    });
    app.get('/auth/strava/callback', async (req: Request, res: Response) => {
      const code = req.query.code as string | undefined;
      if (!code) { res.status(400).send('Missing authorization code'); return; }
      try {
        const tokens = await stravaClient.exchangeCodeForTokens(code);
        db.saveStravaTokens(tokens);
        const result = await stravaSync.syncActivities();
        res.send(`<html><body style="font-family:sans-serif;padding:24px;"><h2>Strava connected ✓</h2><p>Athlete ID: ${tokens.athlete_id}</p><p>Initial sync: ${result.inserted} activities imported.</p><p>Latest: ${result.latest || 'n/a'}</p><p>You can close this tab.</p></body></html>`);
      } catch (e: any) {
        res.status(500).send(`Strava auth failed: ${e.message}`);
      }
    });

    app.get('/health', (_req: Request, res: Response) => {
      res.json({ status: 'ok', authenticated: Boolean(db.getTokens()), withings_authenticated: Boolean(db.getWithingsTokens()), strava_authenticated: Boolean(db.getStravaTokens()) });
    });

    app.all('/mcp', async (req: Request, res: Response) => {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      if (req.method === 'DELETE' && sessionId && transports.has(sessionId)) {
        const session = transports.get(sessionId)!;
        await session.transport.close();
        transports.delete(sessionId);
        res.status(200).send('Session closed');
        return;
      }
      if (req.method === 'POST') {
        let transport: StreamableHTTPServerTransport;
        if (sessionId && transports.has(sessionId)) {
          const session = transports.get(sessionId)!;
          session.lastAccess = Date.now();
          transport = session.transport;
        } else if (sessionId) {
          res.status(404).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Session not found' }, id: null });
          return;
        } else {
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => crypto.randomUUID(),
            onsessioninitialized: newSessionId => { transports.set(newSessionId, { transport, lastAccess: Date.now() }); },
          });
          const server = createMcpServer();
          await server.connect(transport);
        }
        await transport.handleRequest(req, res);
        return;
      }
      res.status(405).send('Method not allowed');
    });

    app.get('/sse', (_req: Request, res: Response) => {
      res.status(410).send('SSE endpoint deprecated. Use /mcp with Streamable HTTP transport.');
    });

    const server = app.listen(config.port, '0.0.0.0', () => {
      process.stdout.write(`Whoop MCP server running on http://0.0.0.0:${config.port}\n`);
    });

    const shutdown = (): void => {
      process.stdout.write('\nShutting down...\n');
      for (const [, session] of transports) { session.transport.close().catch(() => {}); }
      transports.clear();
      db.close();
      server.close(() => process.exit(0));
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
  }
}

main().catch(error => {
  process.stderr.write(`Fatal error: ${error}\n`);
  process.exit(1);
});
