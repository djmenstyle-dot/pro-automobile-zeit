"use client";

import { useEffect, useMemo, useState } from "react";
import { supabase } from "../lib/supabaseClient";

type Job = {
  id: string;
  title: string;
  customer: string | null;
  vehicle: string | null;
  plate: string | null;
  status: string | null; // "open" | "done"
  created_at: string;
  closed_at: string | null;
};

const ADMIN_PIN = process.env.NEXT_PUBLIC_ADMIN_PIN || "";

function askPin(): boolean {
  if (!ADMIN_PIN) {
    alert("Admin PIN fehlt. In Vercel Env Var NEXT_PUBLIC_ADMIN_PIN setzen.");
    return false;
  }
  const p = window.prompt("Admin PIN eingeben:");
  return (p || "").trim() === ADMIN_PIN;
}

export default function Home() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);

  // Formular
  const [title, setTitle] = useState("");
  const [customer, setCustomer] = useState("");
  const [vehicle, setVehicle] = useState("");
  const [plate, setPlate] = useState("");

  // UI
  const [tab, setTab] = useState<"open" | "done">("open");
  const [search, setSearch] = useState("");

  const canCreate = useMemo(() => {
    return title.trim().length > 0 && plate.trim().length > 0; // ✅ Kontrollschild Pflicht
  }, [title, plate]);

  async function loadJobs() {
    setLoading(true);

    const s = search.trim();
    let q = supabase.from("jobs").select("*");

    if (s.length > 0) {
      // 🔎 Suche über plate + customer + vehicle + title (offen + done)
      const like = `%${s}%`;
      q = q.or(
        `plate.ilike.${like},customer.ilike.${like},vehicle.ilike.${like},title.ilike.${like}`
      );
      q = q.order("created_at", { ascending: false }).limit(200);
    } else {
      // Tabs
      q = q.eq("status", tab);
      if (tab === "open") q = q.order("created_at", { ascending: false }).limit(200);
      else q = q.order("closed_at", { ascending: false, nullsFirst: false }).limit(200);
    }

    const { data, error } = await q;
    if (error) {
      console.log(error.message);
      setJobs([]);
    } else {
      setJobs((data as any) || []);
    }

    setLoading(false);
  }

  useEffect(() => {
    loadJobs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  useEffect(() => {
    const t = setTimeout(() => loadJobs(), 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  async function createJob() {
    if (!canCreate) return;

    const { data, error } = await supabase
      .from("jobs")
      .insert({
        title: title.trim(),
        customer: customer.trim() || null,
        vehicle: vehicle.trim() || null,
        plate: plate.trim().toUpperCase(),
        status: "open",
        closed_at: null,
      })
      .select("id")
      .single();

    if (error) return alert(error.message);

    setTitle("");
    setCustomer("");
    setVehicle("");
    setPlate("");

    window.location.href = `/job/${data.id}`;
  }

  async function deleteArchiveDone() {
    if (!askPin()) return;

    const ok = window.confirm("Wirklich ALLE abgeschlossenen Aufträge löschen? (inkl. Zeiten)");
    if (!ok) return;

    // Hole alle done jobs IDs
    const { data: doneJobs, error: e1 } = await supabase
      .from("jobs")
      .select("id")
      .eq("status", "done")
      .limit(5000);

    if (e1) return alert(e1.message);

    const ids = (doneJobs || []).map((x: any) => x.id);
    if (ids.length === 0) return alert("Keine abgeschlossenen Aufträge vorhanden.");

    // Erst time_entries löschen, dann jobs
    const { error: e2 } = await supabase.from("time_entries").delete().in("job_id", ids);
    if (e2) return alert(e2.message);

    const { error: e3 } = await supabase.from("jobs").delete().in("id", ids);
    if (e3) return alert(e3.message);

    alert("✅ Archiv gelöscht");
    await loadJobs();
  }

  return (
    <div>
      <div className="card">
        <div className="row">
          <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
            <div className="logoWrap">
              <img src="/logo.png" alt="Pro Automobile" />
            </div>
            <div>
              <div className="h1">Pro Automobile</div>
              <div className="muted">Auftrag erstellen → QR → Start/Stop am Handy</div>
            </div>
          </div>
          <span className="badge">
            <span className="badgeDot" />
            Live
          </span>
        </div>
      </div>

      {/* Neuer Auftrag */}
      <div className="card">
        <div className="h2" style={{ marginBottom: 10 }}>
          Neuen Auftrag anlegen
        </div>

        <input
          className="input"
          placeholder="Titel (z.B. Müller – Golf – Service)"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />

        <div className="grid2" style={{ marginTop: 10 }}>
          <input
            className="input"
            placeholder="Kunde (optional)"
            value={customer}
            onChange={(e) => setCustomer(e.target.value)}
          />
          <input
            className="input"
            placeholder="Fahrzeug (optional)"
            value={vehicle}
            onChange={(e) => setVehicle(e.target.value)}
          />
        </div>

        <div className="grid2" style={{ marginTop: 10 }}>
          <input
            className="input"
            placeholder="Kontrollschild / Kennzeichen (Pflicht!)"
            value={plate}
            onChange={(e) => setPlate(e.target.value.toUpperCase())}
          />
          <button className="btn btnPrimary" onClick={createJob} disabled={!canCreate}>
            Auftrag erstellen
          </button>
        </div>

        {!plate.trim() && (
          <div className="muted" style={{ fontSize: 12, marginTop: 10 }}>
            ⚠️ Ohne Kontrollschild kann kein Auftrag erstellt werden.
          </div>
        )}
      </div>

      {/* Suche + Tabs */}
      <div className="card">
        <div className="row">
          <div className="h2">Aufträge</div>
          <button className="btn btnDark" style={{ width: 160 }} onClick={loadJobs}>
            Aktualisieren
          </button>
        </div>

        <div className="grid2" style={{ marginTop: 10 }}>
          <button
            className={"btn " + (tab === "open" ? "btnPrimary" : "btnDark")}
            onClick={() => setTab("open")}
            disabled={search.trim().length > 0}
          >
            Aktuell
          </button>
          <button
            className={"btn " + (tab === "done" ? "btnPrimary" : "btnDark")}
            onClick={() => setTab("done")}
            disabled={search.trim().length > 0}
          >
            Abgeschlossen
          </button>
        </div>

        <input
          className="input"
          style={{ marginTop: 10 }}
          placeholder="Suchen: Kontrollschild / Kunde / Fahrzeug / Titel (findet offen + abgeschlossen)"
          value={search}
          onChange={(e) => setSearch(e.target.value.toUpperCase())}
        />

        <div className="grid2" style={{ marginTop: 10 }}>
          <button className="btn btnDark" onClick={() => setSearch("")}>
            Suche löschen
          </button>
          <button className="btn btnDanger" onClick={deleteArchiveDone}>
            Archiv löschen (Admin PIN)
          </button>
        </div>

        {loading ? (
          <div className="muted" style={{ marginTop: 10 }}>
            Lädt…
          </div>
        ) : jobs.length === 0 ? (
          <div className="muted" style={{ marginTop: 10 }}>
            Keine Treffer.
          </div>
        ) : (
          <div style={{ marginTop: 10, display: "grid", gap: 10 }}>
            {jobs.map((j) => {
              const done = (j.status || "open") === "done";
              return (
                <a
                  key={j.id}
                  href={`/job/${j.id}`}
                  style={{
                    textDecoration: "none",
                    color: "inherit",
                    border: "1px solid rgba(255,255,255,.10)",
                    borderRadius: 18,
                    padding: 12,
                    background: "rgba(0,0,0,.20)",
                  }}
                >
                  <div className="row">
                    <div>
                      <div style={{ fontWeight: 900 }}>{j.title}</div>
                      <div className="muted" style={{ fontSize: 13 }}>
                        {[j.customer, j.vehicle, j.plate].filter(Boolean).join(" · ")}
                      </div>
                      {done && j.closed_at && (
                        <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                          Abgeschlossen: {new Date(j.closed_at).toLocaleString("de-CH")}
                        </div>
                      )}
                    </div>
                    <span className={"badge " + (done ? "badgeDone" : "")}>
                      <span className="badgeDot" />
                      {done ? "Abgeschlossen" : "Offen"}
                    </span>
                  </div>
                </a>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
