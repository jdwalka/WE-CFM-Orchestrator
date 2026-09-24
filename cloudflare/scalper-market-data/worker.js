export default {
  async fetch(request, env, ctx) {
    // 1. Handle CORS Preflight
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const url = new URL(request.url);

    // 2. Health Check (Public)
    if (url.pathname === "/health" || url.pathname === "/") {
      return Response.json(
        { status: "online", timestamp: new Date().toISOString() },
        { headers: corsHeaders }
      );
    }

    // 3. Bearer Token Authentication
    const authHeader = request.headers.get("Authorization");
    const token = authHeader?.startsWith("Bearer ") ? authHeader.substring(7) : null;

    if (!env.API_SECRET || token !== env.API_SECRET) {
      return Response.json(
        { error: "Unauthorized: Invalid or missing API secret" },
        { status: 401, headers: corsHeaders }
      );
    }

    // Select active database binding (falls back to DB or GOOGLE_DB)
    const db = env.CALIBRATION_DB || env.DB || env.GOOGLE_DB;
    if (!db) {
      return Response.json(
        { error: "Database binding not configured on Worker" },
        { status: 500, headers: corsHeaders }
      );
    }

    try {
      // 4. Endpoint: Fetch Latest Calibration Record
      if (url.pathname === "/calibration/latest" && request.method === "GET") {
        const query = `
          SELECT * FROM calibration_ledger 
          ORDER BY timestamp DESC LIMIT 1
        `;
        const result = await db.prepare(query).first();
        return Response.json({ success: true, data: result }, { headers: corsHeaders });
      }

      // 5. Endpoint: Fetch Recent Calibration Ledger
      if (url.pathname === "/calibration/ledger" && request.method === "GET") {
        const limit = Math.min(parseInt(url.searchParams.get("limit") || "50", 10), 200);
        const query = `
          SELECT * FROM calibration_ledger 
          ORDER BY timestamp DESC LIMIT ?
        `;
        const { results } = await db.prepare(query).bind(limit).all();
        return Response.json({ success: true, count: results.length, data: results }, { headers: corsHeaders });
      }

      // 6. Endpoint: Ingest New Calibration Point (Trufflezzz / ASI:One)
      if (url.pathname === "/calibration/record" && request.method === "POST") {
        const payload = await request.json();
        const {
          market_id,
          strike_price,
          brti_divergence,
          student_t_factor,
          tail_risk_prob,
          predicted_side,
          confidence
        } = payload;

        const insertQuery = `
          INSERT INTO calibration_ledger (
            timestamp, market_id, strike_price, brti_divergence, 
            student_t_factor, tail_risk_prob, predicted_side, confidence
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `;

        await db.prepare(insertQuery).bind(
          new Date().toISOString(),
          market_id || "UNKNOWN",
          strike_price || 0,
          brti_divergence || 0,
          student_t_factor || 1.0,
          tail_risk_prob || 0.0,
          predicted_side || null,
          confidence || 0.0
        ).run();

        return Response.json({ success: true, message: "Calibration recorded" }, { status: 201, headers: corsHeaders });
      }

      // 7. Endpoint: Read-Only SQL Pass-Through (Arbitrary Edge Audits)
      if (url.pathname === "/query" && request.method === "POST") {
        const body = await request.json();
        const sql = body.sql?.trim();

        if (!sql) {
          return Response.json({ error: "Missing SQL statement in body" }, { status: 400, headers: corsHeaders });
        }

        // Enforce Read-Only safety check
        const normalized = sql.toUpperCase();
        if (
          normalized.startsWith("INSERT") ||
          normalized.startsWith("UPDATE") ||
          normalized.startsWith("DELETE") ||
          normalized.startsWith("DROP") ||
          normalized.startsWith("ALTER")
        ) {
          return Response.json({ error: "Mutation statements blocked on /query endpoint" }, { status: 403, headers: corsHeaders });
        }

        const params = body.params || [];
        const { results } = await db.prepare(sql).bind(...params).all();
        return Response.json({ success: true, results }, { headers: corsHeaders });
      }

      return Response.json({ error: "Endpoint not found" }, { status: 404, headers: corsHeaders });
    } catch (err) {
      return Response.json(
        { error: "Database execution failed", details: err.message },
        { status: 500, headers: corsHeaders }
      );
    }
  }
};
