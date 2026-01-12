"use client";

import { useEffect, useMemo, useState } from "react";
import { supabase } from "../lib/supabaseClient";

type Job = {
  id: string;
  title: string;
  customer: string | null;
  vehicle: string | null;
  plate: string | null;
  status: string | null;
  created_at: string;
};

export default function Home() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);

  const [title, setTitle] = useState("");
  const [customer, setCustomer] = useState("");
  const [vehicle, setVehicle] = useState("");
  const [plate, setPlate] = useState("");

  const canCreate = useMemo(() => title.trim().length > 0, [title]);

  async function loadJobs() {
    setLoading(true);
    const { data } = await supabase
      .from("jobs")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(100);
    setJobs((data as any) || []);
    setLoading(false);
  }

  useEffect(() => {
    loadJobs();
  }, []);

  async function createJob() {
    if (!canCreate) return;

    const { data, error } = await supabase
      .from("jobs")
      .insert({
        title: title.trim(),
        customer: customer.trim() || null,
        vehicle: vehicle.trim() || null,
        plate: plate.trim() || null,
        status: "open",
      })
      .select("id")
      .single();

    if (error) return alert(error.message);

    window.location.href = `/job/${data.id}`;
  }

  return (
    <div>
      <div className="card">
        <div className="row">
          <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
            <div className="logoWrap">
              {/* PNG ist sichtbar, auch wenn SVG weiss ist */}
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
            placeholder="Kontrollschild / Kennzeichen (optional)"
            value={plate}
            onChange={(e) => setPlate(e.target.value)}
          />
          <button className={"btn btnPrimary"} onClick={createJob} disabled={!canCreate}>
            Auftrag erstellen
          </button>
        </div>

        <div className="muted" style={{ fontSize: 12, marginTop: 10 }}>
          Tipp: Auf Samsung Chrome → ⋮ → <b>App installieren</b>
        </div>
      </div>

      <div className="card">
        <div className="row">
          <div className="h2">Letzte Aufträge</div>
          <button className="btn btnDark" style={{ width: 160 }} onClick={loadJobs}>
            Aktualisieren
          </button>
        </div>

        {loading ? (
          <div className="muted" style={{ marginTop: 10 }}>
            Lädt…
          </div>
        ) : jobs.length === 0 ? (
          <div className="muted" style={{ marginTop: 10 }}>
            Noch keine Aufträge.
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
