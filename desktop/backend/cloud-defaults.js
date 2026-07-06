/* Cadence — bundled Cloud Sync defaults.
 *
 * Same Supabase project as PipeWise (the Cadence tables are cadence_-
 * prefixed, so the two apps coexist without touching each other's data,
 * and your existing PipeWise account signs straight in).
 *
 * Why committing the anon key is OK: it is a public-by-design API key —
 * Row Level Security (cloud/supabase-schema.sql enforces
 * user_id = auth.uid() on every cadence_ table) is the security boundary.
 * The service_role key is never committed and never lives on a client.
 *
 * Point at a different project by setting cloudUrl/cloudAnonKey in the
 * settings store — overrides always win over these defaults.
 */

module.exports = {
  supabaseUrl: "https://oslmpcsfqkqsmjhcylgb.supabase.co",
  supabaseAnonKey:
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9zbG1wY3NmcWtxc21qaGN5bGdiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk4ODgxOTAsImV4cCI6MjA5NTQ2NDE5MH0.D2QvRfoNU4Mci3xEoZnMb_802sPvC-08QRJunx2FqyA",
};
