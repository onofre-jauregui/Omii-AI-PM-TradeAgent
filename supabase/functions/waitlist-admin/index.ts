import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, preflight } from "../_shared/cors.ts";

serve(async (req) => {
  if (req.method === "OPTIONS") return preflight();

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !supabaseKey) {
    return new Response(JSON.stringify({ error: "Missing Supabase credentials" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Require an authenticated user — verify the JWT from the Authorization header.
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Verify the caller is an authenticated user (any signed-in user).
  // The frontend does an additional email check before rendering the page.
  const anonClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY") ?? supabaseKey, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user }, error: authErr } = await anonClient.auth.getUser();
  if (authErr || !user) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Service role client bypasses the service-role-only RLS on waitlist.
  const supabase = createClient(supabaseUrl, supabaseKey);

  const { data: rows, error } = await supabase
    .from("waitlist")
    .select("id, email, created_at")
    .order("created_at", { ascending: false });

  if (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const url = new URL(req.url);
  if (url.searchParams.get("format") === "csv") {
    const csv = [
      "Email,Signed Up At",
      ...(rows ?? []).map(r => `${r.email},${r.created_at}`),
    ].join("\n");
    return new Response(csv, {
      headers: {
        ...corsHeaders,
        "Content-Type": "text/csv",
        "Content-Disposition": `attachment; filename="waitlist-${new Date().toISOString().slice(0, 10)}.csv"`,
      },
    });
  }

  return new Response(JSON.stringify({ count: rows?.length ?? 0, rows }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
