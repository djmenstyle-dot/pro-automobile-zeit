import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { bucket, paths, pin } = body as { bucket: string; paths: string[]; pin: string };

    if (!bucket || !Array.isArray(paths) || paths.length === 0) {
      return NextResponse.json({ ok: false, error: "bucket/paths fehlen" }, { status: 400 });
    }

    const adminPin = process.env.ADMIN_PIN || process.env.NEXT_PUBLIC_ADMIN_PIN || "";
    if (!adminPin) return NextResponse.json({ ok: false, error: "Admin PIN fehlt am Server" }, { status: 500 });

    if (!pin || String(pin).trim() !== adminPin) {
      return NextResponse.json({ ok: false, error: "PIN falsch" }, { status: 401 });
    }

    const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
    if (!url || !serviceKey) {
      return NextResponse.json({ ok: false, error: "Server Supabase Env fehlt" }, { status: 500 });
    }

    const supabaseAdmin = createClient(url, serviceKey);

    const { error } = await supabaseAdmin.storage.from(bucket).remove(paths);
    if (error) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    }

    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}
