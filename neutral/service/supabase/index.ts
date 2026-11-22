// Hosts the Nexus integration service as a Supabase Edge Function named "nexus" in Nexus's own project.
// Callers use  https://<project>.supabase.co/functions/v1/nexus  as the base and add /v1/… to it.
// verify_jwt is off: the service does its own authentication with Nexus keys. The database address is a platform secret.
import postgres from "npm:postgres@3.4.5";
import { makeHandler } from "./handler.js";
const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { max: 4, prepare: false, idle_timeout: 20, connect_timeout: 10 });
const handle = makeHandler((q: string, p: (string | null)[]) => sql.unsafe(q, p), (m: string) => console.error("nexus:", m));
Deno.serve((req: Request) => {
  const u = new URL(req.url); u.pathname = u.pathname.replace(/^.*?\/nexus(?=\/|$)/, "") || "/";
  return handle(new Request(u, req));
});
