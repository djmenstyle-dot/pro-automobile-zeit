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
};

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
  const [searchPlate, setSearchPlate] = useState("");

  const canCreate = useMemo(() => {
    return title.trim().length > 0 && plate.trim().length > 0; // ✅ Kennzeichen Pflicht
  }, [title, plate]);

  async function loadJobs() {
    setLoading(true);

    // Wenn Suche aktiv: wir holen beide Status (open + done) und filtern nach plate
    // Wenn keine Suche: wir holen nur den Tab-Status
    let q = supabase.from("jobs").select("*").order("created_at", { ascending: false }).limit(200);

    const s = searchPlate.trim();
    if (s.length > 0) {
      // Suche in beiden Menüs
      q = q.ilike("plate", `%${s}%`);
    } else {
      // Kein Suchtext → Tab filtert
      q = q.eq("status", tab);
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

  // Wenn Suchtext geändert wird: neu laden (mit kleiner Verzögerung)
  useEffect(() => {
    const t = setTimeout(() => loadJobs(), 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchPlate]);

  async function createJob() {
    if (!canCreate) return;

    const { data, error } = await supabase
      .from("jobs")
      .insert({
        title: title.trim(),
        customer: customer.trim() || null,
        vehicle: vehicle.trim() || null,
        plate: plate.trim(), // ✅ Pflicht
        status: "open",
      })
      .select("id")
      .single();

    if (error) return alert(error.message);

    window.location.href = `/job/${data.id}`;
  }

  return (
    <div>
      {/* Header */}
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
            disabled={searchPlate.trim().length > 0}
            title={searchPlate.trim().length > 0 ? "Tab ist deaktiviert während Suche aktiv ist" : ""}
          >
            Aktuell
          </button>
          <button
            className={"btn " + (tab === "done" ? "btnPrimary" : "btnDark")}
            onClick={() => setTab("done")}
            disabled={searchPlate.trim().length > 0}
            title={searchPlate.trim().length > 0 ? "Tab ist deaktiviert während Suche aktiv ist" : ""}
          >
            Abgeschlossen
          </button>
        </div>

        <input
          className="input"
          style={{ marginTop: 10 }}
          placeholder="Suchen nach Kontrollschild (findet offen + abgeschlossen)"
          value={searchPlate}
          onChange={(e) => setSearchPlate(e.target.value.toUpperCase())}
        />

        <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
          {searchPlate.trim().length > 0
            ? "🔎 Suche aktiv: zeigt Treffer aus offenen UND abgeschlossenen Aufträgen."
            : tab === "open"
            ? "Zeigt nur aktuelle Aufträge."
            : "Zeigt nur abgeschlossene Aufträge."}
        </div>

        {/* Liste */}
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
