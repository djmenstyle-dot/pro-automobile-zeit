import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export async function POST(req: Request) {
  try {
    const { bucket, path, pin } = await req.json();

    const ADMIN_PIN = process.env.NEXT_PUBLIC_ADMIN_PIN || "";
    if (!ADMIN_PIN) {
      return NextResponse.json({ ok: false, error: "Admin PIN fehlt am Server." }, { status: 500 });
    }
    if (!pin || String(pin).trim() !== ADMIN_PIN) {
      return NextResponse.json({ ok: false, error: "PIN falsch." }, { status: 401 });
    }

    const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || "";
    const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

    if (!SUPABASE_URL || !SERVICE_KEY) {
      return NextResponse.json(
        { ok: false, error: "SUPABASE_SERVICE_ROLE_KEY oder SUPABASE_URL fehlt in Vercel." },
        { status: 500 }
      );
    }

    const sb = createClient(SUPABASE_URL, SERVICE_KEY);

    const { error } = await sb.storage.from(bucket).remove([path]);
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 400 });

    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || "Unknown error" }, { status: 500 });
  }
}
