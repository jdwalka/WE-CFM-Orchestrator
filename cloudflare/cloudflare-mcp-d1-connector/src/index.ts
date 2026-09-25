/**
 * cloudflare-mcp-d1-connector — secure REST + MCP endpoint for 4 D1 databases.
 *
 * Bindings:
 *   DB_GOOGLE    -> google (001e31f4-...)
 *   DB_SCALPER   -> scalper-calibration (48536b22-...)
 *   DB_OPPONENTS -> opponents (caae95aa-...)
 *   DB_LEAKSNIPE -> leaksnipe-hands (9a9ba1db-...)
 *
 * REST:
 *   GET  /health, /
 *   GET  /dbs
 *   GET  /tables?db=<alias>
 *   GET  /schema?db=<alias>&table=<name>
 *   POST /query   {db, sql, params[]}  (read-only, auth if API_SECRET set)
 *   POST /execute {db, sql, params[]}  (writes allowed, auth required)
 *   GET  /calibration/latest
 *   GET  /calibration/ledger?limit=50
 *   POST /calibration/record {...}
 *
 * MCP (JSON-RPC over POST /mcp):
 *   initialize, tools/list, tools/call
 *   tools: d1_query, d1_tables, d1_schema, calibration_latest
 */

interface Env {
  DB_GOOGLE: D1Database;
  DB_SCALPER: D1Database;
  DB_OPPONENTS: D1Database;
  DB_LEAKSNIPE: D1Database;
  API_SECRET?: string;
}

const DB_ALIASES: Record<string, keyof Env> = {
  google: "DB_GOOGLE",
  db_google: "DB_GOOGLE",
  scalper: "DB_SCALPER",
  "scalper-calibration": "DB_SCALPER",
  db_scalper: "DB_SCALPER",
  calibration: "DB_SCALPER",
  opponents: "DB_OPPONENTS",
  db_opponents: "DB_OPPONENTS",
  leaksnipe: "DB_LEAKSNIPE",
  "leaksnipe-hands": "DB_LEAKSNIPE",
  db_leaksnipe: "DB_LEAKSNIPE",
  hands: "DB_LEAKSNIPE",
};

const DB_META = [
  { alias: "google", binding: "DB_GOOGLE", database_name: "google", database_id: "001e31f4-52ad-4514-8d64-1bd7f0ab3e20" },
  { alias: "scalper", binding: "DB_SCALPER", database_name: "scalper-calibration", database_id: "48536b22-03b3-42dd-92fa-44feab144d84" },
  { alias: "opponents", binding: "DB_OPPONENTS", database_name: "opponents", database_id: "caae95aa-2359-41c8-ab44-13e4860a1d01" },
  { alias: "leaksnipe", binding: "DB_LEAKSNIPE", database_name: "leaksnipe-hands", database_id: "9a9ba1db-5e5e-4fd7-9ff4-bcd6e25ddc2e" },
];

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

function json(data: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(), ...extra },
  });
}

function resolveDb(env: Env, raw?: string | null): { db: D1Database; alias: string; binding: string } | { error: string } {
  const key = (raw || "scalper").toLowerCase().trim();
  const binding = DB_ALIASES[key];
  if (!binding) {
    return { error: `Unknown db '${raw}'. Use one of: google, scalper, opponents, leaksnipe` };
  }
  const db = env[binding] as unknown as D1Database | undefined;
  if (!db) return { error: `Database binding ${binding} not configured on Worker` };
  const meta = DB_META.find((m) => m.binding === binding);
  return { db, alias: meta?.alias ?? key, binding };
}

function checkAuth(request: Request, env: Env): boolean {
  if (!env.API_SECRET) return true; // open in dev until secret is set
  const h = request.headers.get("Authorization") || "";
  return h === `Bearer ${env.API_SECRET}`;
}

function isWriteSql(sql: string): boolean {
  const t = sql.trim().toUpperCase();
  return (
    t.startsWith("INSERT") ||
    t.startsWith("UPDATE") ||
    t.startsWith("DELETE") ||
    t.startsWith("DROP") ||
    t.startsWith("ALTER") ||
    t.startsWith("CREATE") ||
    t.startsWith("REPLACE") ||
    t.startsWith("TRUNCATE") ||
    t.startsWith("GRANT") ||
    t.includes(";")
  );
}

const MCP_TOOLS = [
  {
    name: "d1_query",
    description: "Run a read-only SELECT against one D1 database. db alias: google | scalper | opponents | leaksnipe.",
    inputSchema: {
      type: "object",
      properties: {
        db: { type: "string", description: "Database alias", default: "scalper" },
        sql: { type: "string", description: "SELECT statement" },
        params: { type: "array", items: {}, description: "Bound parameters" },
      },
      required: ["sql"],
    },
  },
  {
    name: "d1_tables",
    description: "List tables in one D1 database.",
    inputSchema: {
      type: "object",
      properties: { db: { type: "string", default: "scalper" } },
    },
  },
  {
    name: "d1_schema",
    description: "Get CREATE TABLE SQL for one table.",
    inputSchema: {
      type: "object",
      properties: {
        db: { type: "string", default: "scalper" },
        table: { type: "string" },
      },
      required: ["table"],
    },
  },
  {
    name: "calibration_latest",
    description: "Fetch latest row from scalper-calibration.calibration_ledger.",
    inputSchema: { type: "object", properties: {} },
  },
];

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    // Public health
    if (url.pathname === "/health" || url.pathname === "/") {
      if (url.pathname === "/" && request.method === "POST") {
        // fall through to MCP for clients posting to root
      } else {
        const dbs: Record<string, boolean> = {};
        for (const m of DB_META) {
          dbs[m.alias] = Boolean((env as unknown as Record<string, unknown>)[m.binding]);
        }
        return json({ status: "online", worker: "cloudflare-mcp-d1-connector", timestamp: new Date().toISOString(), dbs });
      }
    }

    // Public DB inventory (no schema leak beyond names/ids already in wrangler)
    if (url.pathname === "/dbs" && request.method === "GET") {
      return json({ success: true, databases: DB_META });
    }

    // Everything else below requires auth when API_SECRET is configured
    const needsAuth =
      url.pathname.startsWith("/query") ||
      url.pathname.startsWith("/execute") ||
      url.pathname.startsWith("/mcp") ||
      url.pathname.startsWith("/tables") ||
      url.pathname.startsWith("/schema") ||
      url.pathname.startsWith("/calibration");
    if (needsAuth && !checkAuth(request, env)) {
      return json({ error: "Unauthorized: Invalid or missing API secret" }, 401);
    }

    try {
      // ---- tables ----
      if (url.pathname === "/tables" && request.method === "GET") {
        const r = resolveDb(env, url.searchParams.get("db"));
        if ("error" in r) return json({ error: r.error }, 400);
        const { results } = await r.db
          .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
          .all<{ name: string }>();
        return json({ success: true, db: r.alias, tables: (results || []).map((t) => t.name) });
      }

      // ---- schema ----
      if (url.pathname === "/schema" && request.method === "GET") {
        const r = resolveDb(env, url.searchParams.get("db"));
        if ("error" in r) return json({ error: r.error }, 400);
        const table = url.searchParams.get("table") || "";
        if (!table || !/^[A-Za-z0-9_]+$/.test(table)) return json({ error: "Invalid table name" }, 400);
        const row = await r.db
          .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?")
          .bind(table)
          .first<{ sql: string }>();
        if (!row) return json({ error: `Table '${table}' not found` }, 404);
        return json({ success: true, db: r.alias, table, sql: row.sql });
      }

      // ---- read-only query ----
      if (url.pathname === "/query" && request.method === "POST") {
        const body = (await request.json().catch(() => ({}))) as { db?: string; sql?: string; params?: unknown[] };
        const sql = (body.sql || "").trim();
        if (!sql) return json({ error: "Missing sql in body" }, 400);
        if (isWriteSql(sql)) return json({ error: "Write statements blocked on /query. Use /execute." }, 403);
        const r = resolveDb(env, body.db);
        if ("error" in r) return json({ error: r.error }, 400);
        const { results } = await r.db.prepare(sql).bind(...(body.params || [])).all();
        return json({ success: true, db: r.alias, count: results?.length ?? 0, results });
      }

      // ---- write execute (auth required) ----
      if (url.pathname === "/execute" && request.method === "POST") {
        const body = (await request.json().catch(() => ({}))) as { db?: string; sql?: string; params?: unknown[] };
        const sql = (body.sql || "").trim();
        if (!sql) return json({ error: "Missing sql in body" }, 400);
        const r = resolveDb(env, body.db);
        if ("error" in r) return json({ error: r.error }, 400);
        const res = await r.db.prepare(sql).bind(...(body.params || [])).run();
        return json({ success: true, db: r.alias, meta: res.meta });
      }

      // ---- calibration (scalper DB) ----
      if (url.pathname === "/calibration/latest" && request.method === "GET") {
        const row = await env.DB_SCALPER.prepare("SELECT * FROM calibration_ledger ORDER BY timestamp DESC LIMIT 1").first();
        return json({ success: true, data: row });
      }

      if (url.pathname === "/calibration/ledger" && request.method === "GET") {
        const limit = Math.min(parseInt(url.searchParams.get("limit") || "50", 10) || 50, 200);
        const { results } = await env.DB_SCALPER.prepare("SELECT * FROM calibration_ledger ORDER BY timestamp DESC LIMIT ?").bind(limit).all();
        return json({ success: true, count: results?.length ?? 0, data: results });
      }

      if (url.pathname === "/calibration/record" && request.method === "POST") {
        const p = (await request.json().catch(() => ({}))) as Record<string, unknown>;
        await env.DB_SCALPER.prepare(
          "INSERT INTO calibration_ledger (timestamp, market_id, strike_price, brti_divergence, student_t_factor, tail_risk_prob, predicted_side, confidence) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
        )
          .bind(
            new Date().toISOString(),
            (p.market_id as string) || "UNKNOWN",
            (p.strike_price as number) ?? 0,
            (p.brti_divergence as number) ?? 0,
            (p.student_t_factor as number) ?? 1.0,
            (p.tail_risk_prob as number) ?? 0.0,
            (p.predicted_side as string) ?? null,
            (p.confidence as number) ?? 0.0
          )
          .run();
        return json({ success: true, message: "Calibration recorded" }, 201);
      }

      // ---- MCP ----
      if ((url.pathname === "/mcp" || url.pathname === "/") && request.method === "POST") {
        const body = (await request.json().catch(() => ({}))) as { jsonrpc?: string; id?: unknown; method?: string; params?: Record<string, unknown> };
        const id = body.id ?? null;
        const ok = (result: unknown) => json({ jsonrpc: "2.0", id, result });
        const err = (code: number, message: string) => json({ jsonrpc: "2.0", id, error: { code, message } });

        if (body.method === "initialize") {
          return ok({ protocolVersion: "2024-11-05", serverInfo: { name: "cloudflare-mcp-d1-connector", version: "1.0.0" }, capabilities: { tools: {} } });
        }
        if (body.method === "notifications/initialized") {
          return new Response(null, { status: 204, headers: corsHeaders() });
        }
        if (body.method === "tools/list") {
          return ok({ tools: MCP_TOOLS });
        }
        if (body.method === "tools/call") {
          const params = body.params || {};
          const tool = params.name as string;
          const args = (params.arguments || {}) as Record<string, unknown>;

          if (tool === "d1_tables") {
            const r = resolveDb(env, (args.db as string) || "scalper");
            if ("error" in r) return err(-32602, r.error);
            const { results } = await r.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all<{ name: string }>();
            const tables = (results || []).map((t) => t.name);
            return ok({ content: [{ type: "text", text: JSON.stringify({ db: r.alias, tables }, null, 2) }] });
          }
          if (tool === "d1_schema") {
            const table = String(args.table || "");
            if (!table || !/^[A-Za-z0-9_]+$/.test(table)) return err(-32602, "Invalid table name");
            const r = resolveDb(env, (args.db as string) || "scalper");
            if ("error" in r) return err(-32602, r.error);
            const row = await r.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").bind(table).first<{ sql: string }>();
            if (!row) return err(-32602, `Table '${table}' not found`);
            return ok({ content: [{ type: "text", text: row.sql }] });
          }
          if (tool === "d1_query") {
            const sql = String(args.sql || "").trim();
            if (!sql) return err(-32602, "Missing sql");
            if (isWriteSql(sql)) return err(-32602, "Write statements blocked on d1_query");
            const r = resolveDb(env, (args.db as string) || "scalper");
            if ("error" in r) return err(-32602, r.error);
            const paramsArr = Array.isArray(args.params) ? (args.params as unknown[]) : [];
            const { results } = await r.db.prepare(sql).bind(...paramsArr).all();
            return ok({ content: [{ type: "text", text: JSON.stringify({ db: r.alias, count: results?.length ?? 0, results }, null, 2) }] });
          }
          if (tool === "calibration_latest") {
            const row = await env.DB_SCALPER.prepare("SELECT * FROM calibration_ledger ORDER BY timestamp DESC LIMIT 1").first();
            return ok({ content: [{ type: "text", text: JSON.stringify(row) }] });
          }
          return err(-32601, `Unknown tool '${tool}'`);
        }
        return err(-32601, `Unknown method '${body.method}'`);
      }

      return json({ error: "Endpoint not found" }, 404);
    } catch (e) {
      return json({ error: "Database execution failed", details: e instanceof Error ? e.message : String(e) }, 500);
    }
  },
};
