"use client";

import { useEffect, useMemo, useState } from "react";
import { supabase } from "./lib/supabaseClient";
import { ensureAdmin, isAdmin, logoutAdmin } from "./lib/admin";

type Job = {
  id: string;
  title: string;
  customer: string | null;
  vehicle: string | null;
  plate: string | null;
  status: string | null; // open | done
  created_at: string;
  closed_at: string | null;
  vin: string | null;
};

type RunningEntry = {
  id: string;
  job_id: string;
  worker: string;
  task: string | null;
  start_ts: string;
};

const ADMIN_PIN = process.env.NEXT_PUBLIC_ADMIN_PIN || "";

function minutesSince(iso: string) {
  const s = new Date(iso).getTime();
  return Math.max(0, Math.round((Date.now() - s) / 60000));
}

function fmtMin(min: number) {
  if (min < 60) return `${min}min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${h}h ${m}min`;
}

export default function Home() {
  const [tab, setTab] = useState<"open" | "done">("open");
  const [search, setSearch] = useState("");
  const [jobs, setJobs] = useState<Job[]>([]);
  const [running, setRunning] = useState<Record<string, RunningEntry[]>>({});
  const [loading, setLoading] = useState(true);

  const [adminOn, setAdminOn] = useState(false);

  // Form
  const [title, setTitle] = useState("");
  const [customer, setCustomer] = useState("");
  const [vehicle, setVehicle] = useState("");
  const [plate, setPlate] = useState("");

  const canCreate = useMemo(() => title.trim().length > 0 && plate.trim().length > 0, [title, plate]);

  async function loadJobs() {
    setLoading(true);

    const s = search.trim();
    let q = supabase.from("jobs").select("*");

    if (s.length > 0) {
      const like = `%${s}%`;
      q = q.or(`plate.ilike.${like},customer.ilike.${like},vehicle.ilike.${like},title.ilike.${like},vin.ilike.${like}`);
      q = q.order("created_at", { ascending: false }).limit(200);
    } else {
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

  async function loadRunningForOpenJobs(openJobIds: string[]) {
    if (openJobIds.length === 0) {
      setRunning({});
      return;
    }

    const { data, error } = await supabase
      .from("time_entries")
      .select("id, job_id, worker, task, start_ts")
      .in("job_id", openJobIds)
      .is("end_ts", null)
      .limit(500);

    if (error) {
      console.log(error.message);
      setRunning({});
      return;
    }

    const map: Record<string, RunningEntry[]> = {};
    for (const r of (data || []) as any[]) {
      map[r.job_id] = map[r.job_id] || [];
      map[r.job_id].push(r as RunningEntry);
    }
    setRunning(map);
  }

  useEffect(() => {
    setAdminOn(typeof window !== "undefined" ? isAdmin() : false);
    loadJobs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  useEffect(() => {
    const t = setTimeout(() => loadJobs(), 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  useEffect(() => {
    const s = search.trim();
    if (s.length > 0) return;
    if (tab !== "open") return;

    const ids = jobs.map((j) => j.id);
    loadRunningForOpenJobs(ids);

    const iv = setInterval(() => loadRunningForOpenJobs(ids), 30000);
    return () => clearInterval(iv);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobs, tab, search]);

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
    if (!ensureAdmin(ADMIN_PIN)) return;
    setAdminOn(true);

    const ok = confirm("Wirklich ALLE abgeschlossenen Aufträge löschen? (inkl. Zeiten)");
    if (!ok) return;

    const { data: doneJobs, error: e1 } = await supabase.from("jobs").select("id").eq("status", "done").limit(5000);
    if (e1) return alert(e1.message);

    const ids = (doneJobs || []).map((x: any) => x.id);
    if (ids.length === 0) return alert("Keine abgeschlossenen Aufträge vorhanden.");

    const { error: e2 } = await supabase.from("time_entries").delete().in("job_id", ids);
    if (e2) return alert(e2.message);

    const { error: e3 } = await supabase.from("jobs").delete().in("id", ids);
    if (e3) return alert(e3.message);

    alert("✅ Archiv gelöscht");
    await loadJobs();
  }

  function toggleAdmin() {
    if (isAdmin()) {
      logoutAdmin();
      setAdminOn(false);
      alert("Chef-Modus aus");
      return;
    }
    const ok = ensureAdmin(ADMIN_PIN);
    setAdminOn(ok);
  }

  return (
    <div className="container">
      <div className="card">
        <div className="row">
          <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
            <div className="logoWrap">
              <img src="/logo.png" alt="Pro Automobile" />
            </div>
            <div>
              <div className="h1">Pro Automobile</div>
              <div className="muted">Live Status · VIN · Fotos · Checkliste · Unterschrift · PDF</div>
            </div>
          </div>

          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <span className={"badge " + (adminOn ? "badgeDone" : "")}>
              <span className="badgeDot" />
              {adminOn ? "Chef-Modus" : "Mitarbeiter"}
            </span>
            <button className={"btn " + (adminOn ? "btnDark" : "btnPrimary")} style={{ width: 170 }} onClick={toggleAdmin}>
              {adminOn ? "Chef-Modus aus" : "Chef PIN"}
            </button>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="h2" style={{ marginBottom: 10 }}>
          Neuen Auftrag anlegen
        </div>

        <input className="input" placeholder="Titel (z.B. Müller – Golf – Service)" value={title} onChange={(e) => setTitle(e.target.value)} />

        <div className="grid2" style={{ marginTop: 10 }}>
          <input className="input" placeholder="Kunde (optional)" value={customer} onChange={(e) => setCustomer(e.target.value)} />
          <input className="input" placeholder="Fahrzeug (optional)" value={vehicle} onChange={(e) => setVehicle(e.target.value)} />
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
      </div>

      <div className="card">
        <div className="row">
          <div className="h2">Aufträge</div>
          <button className="btn btnDark" style={{ width: 160 }} onClick={loadJobs}>
            Aktualisieren
          </button>
        </div>

        <div className="grid2" style={{ marginTop: 10 }}>
          <button className={"btn " + (tab === "open" ? "btnPrimary" : "btnDark")} onClick={() => setTab("open")} disabled={search.trim().length > 0}>
            Aktuell
          </button>
          <button className={"btn " + (tab === "done" ? "btnPrimary" : "btnDark")} onClick={() => setTab("done")} disabled={search.trim().length > 0}>
            Abgeschlossen
          </button>
        </div>

        <input
          className="input"
          style={{ marginTop: 10 }}
          placeholder="Suchen: Kontrollschild / Kunde / Fahrzeug / Titel / VIN (findet offen + abgeschlossen)"
          value={search}
          onChange={(e) => setSearch(e.target.value.toUpperCase())}
        />

        <div className="grid2" style={{ marginTop: 10 }}>
          <button className="btn btnDark" onClick={() => setSearch("")}>Suche löschen</button>
          <button className="btn btnDanger" onClick={deleteArchiveDone}>Archiv löschen (Chef)</button>
        </div>

        {loading ? (
          <div className="muted" style={{ marginTop: 10 }}>Lädt…</div>
        ) : jobs.length === 0 ? (
          <div className="muted" style={{ marginTop: 10 }}>Keine Treffer.</div>
        ) : (
          <div style={{ marginTop: 10, display: "grid", gap: 10 }}>
            {jobs.map((j) => {
              const done = (j.status || "open") === "done";
              const live = running[j.id] || [];

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
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: 900 }}>{j.title}</div>
                      <div className="muted" style={{ fontSize: 13 }}>
                        {[j.customer, j.vehicle, j.plate, j.vin ? `VIN: ${j.vin}` : null].filter(Boolean).join(" · ")}
                      </div>

                      {!done && search.trim().length === 0 && tab === "open" && (
                        <div style={{ marginTop: 8, display: "grid", gap: 4 }}>
                          {live.length === 0 ? (
                            <div className="muted" style={{ fontSize: 12 }}>— niemand läuft —</div>
                          ) : (
                            live.map((r) => (
                              <div key={r.id} className="muted" style={{ fontSize: 12 }}>
                                🟢 <b>{r.worker}</b> {r.task ? `(${r.task})` : ""} · {fmtMin(minutesSince(r.start_ts))}
                              </div>
                            ))
                          )}
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
