import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";

if (!url || !anon) {
  // Nicht throwen -> sonst crasht Build, wir zeigen später eine Meldung in der App
  // console.warn("Missing Supabase env vars");
}

export const supabase = createClient(url, anon);
