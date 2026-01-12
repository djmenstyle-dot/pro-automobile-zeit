"use client";

import { useEffect, useMemo, useState } from "react";
import { supabase } from "../lib/supabaseClient";

type Job = {
  id: string;
  title: string;
  customer: string | null;
  vehicle: string | null;
  plate: string | null;
  status: string;
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
    const { data, error } = await supabase
      .from("jobs")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(100);
    if (!error && data) setJobs(data as any);
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
        plate: plate.trim() || null
      })
      .select("id")
      .single();

    if (error) {
      alert(error.message);
      return;
    }
    const id = data.id as string;
    window.location.href = `/job/${id}`;
  }

  return (
    <div>
      <header style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 12 }}>
        <img src="/logo.svg" alt="Pro Automobile" style={{ width: 56, height: 56, borderRadius: 12, objectFit: "contain", background: "#fff", border: "1px solid #eee", padding: 6 }} />
        <div>
          <div style={{ fontSize: 22, fontWeight: 800 }}>Pro Automobile</div>
          <div style={{ color: "#666" }}>Auftrag erstellen → QR → Start/Stop am Handy</div>
        </div>
      </header>

      <div style={card()}>
        <div style={{ fontWeight: 800, marginBottom: 8 }}>Neuen Auftrag anlegen</div>

        <input
          placeholder="Titel (z.B. Müller – Golf – Service)"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          style={inp()}
        />

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <input placeholder="Kunde (optional)" value={customer} onChange={(e) => setCustomer(e.target.value)} style={inp()} />
          <input placeholder="Fahrzeug (optional)" value={vehicle} onChange={(e) => setVehicle(e.target.value)} style={inp()} />
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <input placeholder="Kennzeichen (optional)" value={plate} onChange={(e) => setPlate(e.target.value)} style={inp()} />
          <button onClick={createJob} disabled={!canCreate} style={btn(!canCreate)}>
            Auftrag erstellen
          </button>
        </div>

        <div style={{ color: "#666", fontSize: 12, marginTop: 8 }}>
          Tipp: Sobald die App auf Vercel ist: Chrome → ⋮ → <b>App installieren</b>
        </div>
      </div>

      <div style={card()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ fontWeight: 800 }}>Letzte Aufträge</div>
          <button onClick={loadJobs} style={btn(false)}>Aktualisieren</button>
        </div>

        {loading ? (
          <div style={{ color: "#666", marginTop: 10 }}>Lädt…</div>
        ) : jobs.length === 0 ? (
          <div style={{ color: "#666", marginTop: 10 }}>Noch keine Aufträge.</div>
        ) : (
          <div style={{ marginTop: 10, display: "grid", gap: 10 }}>
            {jobs.map((j) => (
              <a
                key={j.id}
                href={`/job/${j.id}`}
                style={{ textDecoration: "none", color: "inherit", border: "1px solid #eee", borderRadius: 14, padding: 12 }}
              >
                <div style={{ fontWeight: 800 }}>{j.title}</div>
                <div style={{ color: "#666", fontSize: 14 }}>
                  {[j.customer, j.vehicle, j.plate].filter(Boolean).join(" · ")}
                </div>
              </a>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function card(): React.CSSProperties {
  return { border: "1px solid #e5e5e5", borderRadius: 16, padding: 14, margin: "12px 0" };
}
function inp(): React.CSSProperties {
  return { width: "100%", padding: 12, fontSize: 16, borderRadius: 12, border: "1px solid #ddd", margin: "6px 0" };
}
function btn(disabled: boolean): React.CSSProperties {
  return {
    width: "100%",
    padding: 12,
    fontSize: 16,
    borderRadius: 12,
    border: "1px solid #111",
    background: disabled ? "#f2f2f2" : "#111",
    color: disabled ? "#999" : "#fff",
    cursor: disabled ? "not-allowed" : "pointer",
    margin: "6px 0"
  };
}
