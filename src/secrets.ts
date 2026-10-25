import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// Server-generated secrets, persisted next to the database (on the Railway volume) so they
// are not stored in environment variables. Environment variables, when set, take priority.

interface StoredSecrets {
  encryptionSecret: string;
  mcpAccessToken: string;
}

let cached: StoredSecrets | null = null;

function secretsPath(): string {
  return join(dirname(process.env.DB_PATH ?? './whoop.db'), 'secrets.json');
}

function load(): StoredSecrets {
  if (cached) return cached;
  const path = secretsPath();
  let stored: Partial<StoredSecrets> = {};
  if (existsSync(path)) {
    stored = JSON.parse(readFileSync(path, 'utf8')) as Partial<StoredSecrets>;
  }
  const secrets: StoredSecrets = {
    encryptionSecret: stored.encryptionSecret || randomBytes(32).toString('hex'),
    mcpAccessToken: stored.mcpAccessToken || randomBytes(32).toString('hex'),
  };
  if (secrets.encryptionSecret !== stored.encryptionSecret || secrets.mcpAccessToken !== stored.mcpAccessToken) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(secrets), { mode: 0o600 });
  }
  cached = secrets;
  return secrets;
}

export function getEncryptionSecret(): string {
  return process.env.ENCRYPTION_SECRET || load().encryptionSecret;
}

export function getMcpAccessToken(): string {
  return process.env.MCP_ACCESS_TOKEN || load().mcpAccessToken;
}
