/**
 * Monthly usage reset script.
 * Run via cron on the 1st of every month:
 *   0 0 1 * * node scripts/reset-usage.js
 * Or schedule via Railway cron jobs.
 */
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.log('Supabase not configured — skipping reset.');
    process.exit(0);
  }

  const sb = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data, error } = await sb
    .from('users')
    .update({ uses_this_month: 0, updated_at: new Date().toISOString() })
    .neq('tier', 'paid'); // Don't reset paid users (they have unlimited)

  if (error) {
    console.error('Reset failed:', error.message);
    process.exit(1);
  }

  console.log('Monthly usage reset complete.');
  process.exit(0);
}

main();
