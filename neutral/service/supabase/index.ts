// Hosts the Nexus integration service as a Supabase Edge Function named "nexus" in Nexus's own project.
// Callers use  https://<project>.supabase.co/functions/v1/nexus  as the base and add /v1/… to it.
// verify_jwt is off: the service does its own authentication with Nexus keys. The database address is a platform secret.
// /site/v1/… is the Nexus website's read-only view (site.js): it accepts the warehouse staff sign-in, never a Nexus key.
import postgres from "npm:postgres@3.4.5";
import { makeHandler } from "./handler.js";
import { makeSite } from "./site.js";
const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { max: 4, prepare: false, idle_timeout: 20, connect_timeout: 10 });
const query = (q: string, p: (string | null)[]) => sql.unsafe(q, p);
const handle = makeHandler(query, (m: string) => console.error("nexus:", m));
// The website signs staff in with the warehouse's existing staff login service. Its address and public browser key are the
// same public values the website itself ships (netlify.toml on main); they grant nothing by themselves.
const site = makeSite(query, {
  authUrl: Deno.env.get("NEXUS_SITE_AUTH_URL") ?? "https://poxlczzkpztmoiixyrth.supabase.co",
  anonKey: Deno.env.get("NEXUS_SITE_AUTH_KEY") ?? "<the public browser key from netlify.toml on main>",
  floor: "HILLSBOROUGH", roles: ["shipbay_admin", "shipbay_staff", "wms_employee"], onError: (m: string) => console.error("nexus site:", m),
});
Deno.serve(async (req: Request) => {
  const u = new URL(req.url); u.pathname = u.pathname.replace(/^.*?\/nexus(?=\/|$)/, "") || "/";
  const r = new Request(u, req);
  return (await site(r)) ?? handle(r);
});
