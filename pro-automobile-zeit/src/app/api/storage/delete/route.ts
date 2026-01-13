import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

type Body = { bucket: string; path: string; pin: string };

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as Body;

    const bucket = body.bucket || "";
    const path = body.path || "";
    const pin = (body.pin || "").trim();

    if (!bucket || !path) {
      return NextResponse.json({ ok: false, error: "bucket/path fehlt" }, { status: 400 });
    }

    const serverPin = (process.env.ADMIN_PIN || process.env.NEXT_PUBLIC_ADMIN_PIN || "").trim();
    if (!serverPin) {
      return NextResponse.json({ ok: false, error: "Server ADMIN_PIN fehlt" }, { status: 500 });
    }
    if (pin !== serverPin) {
      return NextResponse.json({ ok: false, error: "PIN falsch" }, { status: 401 });
    }

    const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
    const service = process.env.SUPABASE_SERVICE_ROLE_KEY!;
    if (!url || !service) {
      return NextResponse.json(
        { ok: false, error: "SUPABASE_SERVICE_ROLE_KEY oder NEXT_PUBLIC_SUPABASE_URL fehlt" },
        { status: 500 }
      );
    }

    const admin = createClient(url, service, { auth: { persistSession: false } });

    const { error } = await admin.storage.from(bucket).remove([path]);
    if (error) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 400 });
    }

    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}
