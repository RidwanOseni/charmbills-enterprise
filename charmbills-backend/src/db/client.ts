import { createClient } from '@libsql/client';

const url = process.env.TURSO_DATABASE_URL;
const authToken = process.env.TURSO_AUTH_TOKEN;

if (!url) {
  throw new Error('TURSO_DATABASE_URL environment variable is required');
}

export const turso = createClient({
  url,
  authToken,
});

export async function testConnection(): Promise<boolean> {
  try {
    await turso.execute('SELECT 1');
    console.log('[DB] ✅ Connection successful');
    return true;
  } catch (error: any) {
    console.error('[DB] ❌ Connection failed:', error.message || error);
    return false;
  }
}