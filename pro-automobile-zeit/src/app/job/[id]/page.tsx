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
  status: string | null;
  created_at?: string | null;
  closed_at?: string | null;
};

const BUCKET = "job-photos";

function badge(status: string | null) {
  const s = status || "open";
  return s === "done" ? "Abgeschlossen" : "Offen";
}

function toLocal(iso?: string | null) {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleString("de-CH");
}

async function uploadRequiredPhoto(jobId: string, file: File, kind: "ausweis" | "km") {
  const ext = (file.name.split(".").pop() || "jpg").toLowerCase();
  const safeExt = ["jpg", "jpeg", "png", "webp"].includes(ext) ? ext : "jpg";
  const filename = `${kind}_${Date.now()}_${Math.random().toString(16).slice(2)}.${safeExt}`;
  const path = `${jobId}/${filename}`;

  const { error } = await supabase.storage.from(BUCKET).upload(path, file, {
    cacheControl: "3600",
    upsert: false,
    contentType: file.type || "image/jpeg",
  });

  if (error) throw new Error(error.message);
}

export default function HomePage() {
  const adminPin = process.env.NEXT_PUBLIC_ADMIN_PIN || "";

  const [title, setTitle] = useState("Pro Automobile ersatzwagen");
  const [customer, setCustomer] = useState("");
  const [vehicle, setVehicle] = useState("");
  const [plate, setPlate] = useState("");
  const [msg, setMsg] = useState("");

  // Pflicht-Fotos
  const [ausweisFile, setAusweisFile] = useState<File | null>(null);
  const [kmFile, setKmFile] = useState<File | null>(null);

  const [jobsOpen, setJobsOpen] = useState<Job[]>([]);
  const [jobsDone, setJobsDone] = useState<Job[]>([]);

  const [q, setQ] = useState(""); // Suche über offen+done
  const [loading, setLoading] = useState(false);

  const canCreate = useMemo(() => {
    const plateOk = plate.trim().length > 0;
    const ausweisOk = !!ausweisFile;
    const kmOk = !!kmFile;
    return plateOk && ausweisOk && kmOk;
  }, [plate, ausweisFile, kmFile]);

  async function load() {
    // Offen (neueste oben)
    const { data: openData } = await supabase
      .from("jobs")
      .select("*")
      .eq("status", "open")
      .order("created_at", { ascending: false })
      .limit(50);

    // Done (nach closed_at, fallback created_at)
    const { data: doneData } = await supabase
      .from("jobs")
      .select("*")
      .eq("status", "done")
      .order("closed_at", { ascending: false, nullsFirst: false })
      .order("created_at", { ascending: false })
      .limit(50);

    setJobsOpen((openData || []) as any);
    setJobsDone((doneData || []) as any);
  }

  useEffect(() => {
    load();
  }, []);

  const filteredOpen = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return jobsOpen;
    return jobsOpen.filter((j) =>
      [j.title, j.customer, j.vehicle, j.plate].filter(Boolean).join(" ").toLowerCase().includes(s)
    );
  }, [q, jobsOpen]);

  const filteredDone = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return jobsDone;
    return jobsDone.filter((j) =>
      [j.title, j.customer, j.vehicle, j.plate].filter(Boolean).join(" ").toLowerCase().includes(s)
    );
  }, [q, jobsDone]);

  async function createJob() {
    setMsg("");
    if (!plate.trim()) return setMsg("Kontrollschild ist Pflicht.");
    if (!ausweisFile) return setMsg("Fahrzeugausweis Foto ist Pflicht.");
    if (!kmFile) return setMsg("Kilometer Foto ist Pflicht.");

    try {
      setLoading(true);

      // 1) Job erstellen
      const { data, error } = await supabase
        .from("jobs")
        .insert({
          title: title.trim() || "Auftrag",
          customer: customer.trim() || null,
          vehicle: vehicle.trim() || null,
          plate: plate.trim().toUpperCase(),
          status: "open",
        })
        .select("id")
        .single();

      if (error) throw new Error(error.message);

      const jobId = data.id as string;

      // 2) Pflicht-Fotos hochladen (Ausweis + KM)
      await uploadRequiredPhoto(jobId, ausweisFile, "ausweis");
      await uploadRequiredPhoto(jobId, kmFile, "km");

      // 3) Weiter zur Auftrag-Seite
      window.location.href = `/job/${jobId}`;
    } catch (e: any) {
      setMsg(e?.message || "Fehler beim Erstellen");
    } finally {
      setLoading(false);
    }
  }

  const chefActive = isAdmin();

  return (
    <div>
      <div className="card">
        <div className="row" style={{ alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
            <div className="logoWrap">
              <img src="/icons/logo.png" alt="Pro Automobile" />
            </div>
            <div>
              <div className="h1">Pro Automobile</div>
              <div className="muted">Auftrag erstellen → Pflicht-Fotos → Start/Stop am Handy</div>
            </div>
          </div>

          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <span className="pill">
              <span className="dot" style={{ background: chefActive ? "#30d158" : "#ff453a" }} />
              {chefActive ? "Chef Modus" : "Normal"}
            </span>

            {chefActive ? (
              <button className="btn" onClick={logoutAdmin}>Chef abmelden</button>
            ) : (
              <button className="btn" onClick={() => ensureAdmin(adminPin)}>Chef PIN</button>
            )}
          </div>
        </div>
      </div>

      <div className="card">
        <div className="h2">Neuen Auftrag anlegen (Pflicht: Ausweis + KM Foto)</div>

        <div className="grid2" style={{ marginTop: 10 }}>
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Auftrag Titel" />
          <input className="input" value={customer} onChange={(e) => setCustomer(e.target.value)} placeholder="Kunde (optional)" />
          <input className="input" value={vehicle} onChange={(e) => setVehicle(e.target.value)} placeholder="Fahrzeug (optional)" />
          <input
            className="input"
            value={plate}
            onChange={(e) => setPlate(e.target.value.toUpperCase())}
            placeholder="Kontrollschild (Pflicht)"
          />
        </div>

        <div className="grid2" style={{ marginTop: 12 }}>
          <label className="btn btnPrimary" style={{ cursor: "pointer" }}>
            Fahrzeugausweis Foto (Pflicht)
            <input
              type="file"
              accept="image/*"
              capture="environment"
              style={{ display: "none" }}
              onChange={(e) => {
                const f = e.target.files?.[0] || null;
                e.target.value = "";
                setAusweisFile(f);
              }}
            />
          </label>

          <label className="btn btnPrimary" style={{ cursor: "pointer" }}>
            Kilometerstand Foto (Pflicht)
            <input
              type="file"
              accept="image/*"
              capture="environment"
              style={{ display: "none" }}
              onChange={(e) => {
                const f = e.target.files?.[0] || null;
                e.target.value = "";
                setKmFile(f);
              }}
            />
          </label>
        </div>

        <div style={{ marginTop: 10, display: "flex", gap: 10, flexWrap: "wrap" }}>
          <span className="pill">
            <span className="dot" style={{ background: ausweisFile ? "#30d158" : "#ff453a" }} />
            Ausweis: {ausweisFile ? "OK" : "fehlt"}
          </span>
          <span className="pill">
            <span className="dot" style={{ background: kmFile ? "#30d158" : "#ff453a" }} />
            KM: {kmFile ? "OK" : "fehlt"}
          </span>
          <span className="muted" style={{ fontSize: 12 }}>
            (Fotos werden im Auftrag gespeichert, damit du später beim Rechnungen schreiben schnell schauen kannst.)
          </span>
        </div>

        {msg && <div className="muted" style={{ marginTop: 10 }}>{msg}</div>}

        <div style={{ marginTop: 12 }}>
          <button className="btn btnDanger" disabled={!canCreate || loading} onClick={createJob}>
            {loading ? "Erstellt…" : "Auftrag erstellen"}
          </button>
        </div>
      </div>

      <div className="card">
        <div className="row">
          <div className="h2">Suche (offen + abgeschlossen)</div>
          <input className="input" placeholder="Suche: Kontrollschild / Kunde / Fahrzeug / Titel" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      </div>

      <div className="card">
        <div className="h2">Aktuelle Aufträge</div>
        {filteredOpen.length === 0 ? (
          <div className="muted" style={{ marginTop: 10 }}>Keine offenen Aufträge.</div>
        ) : (
          <div style={{ marginTop: 10, display: "grid", gap: 10 }}>
            {filteredOpen.map((j) => (
              <a key={j.id} className="jobCard" href={`/job/${j.id}`} style={{ textDecoration: "none" }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
                  <div>
                    <div className="jobTitle">{j.title}</div>
                    <div className="muted">{[j.customer, j.vehicle, j.plate].filter(Boolean).join(" · ")}</div>
                    <div className="muted" style={{ fontSize: 12 }}>Erstellt: {toLocal(j.created_at || null)}</div>
                  </div>
                  <span className="pill">
                    <span className="dot" />
                    {badge(j.status)}
                  </span>
                </div>
              </a>
            ))}
          </div>
        )}
      </div>

      <div className="card">
        <div className="h2">Abgeschlossene Aufträge</div>
        {filteredDone.length === 0 ? (
          <div className="muted" style={{ marginTop: 10 }}>Keine abgeschlossenen Aufträge.</div>
        ) : (
          <div style={{ marginTop: 10, display: "grid", gap: 10 }}>
            {filteredDone.map((j) => (
              <a key={j.id} className="jobCard" href={`/job/${j.id}`} style={{ textDecoration: "none", opacity: 0.92 }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
                  <div>
                    <div className="jobTitle">{j.title}</div>
                    <div className="muted">{[j.customer, j.vehicle, j.plate].filter(Boolean).join(" · ")}</div>
                    <div className="muted" style={{ fontSize: 12 }}>
                      Abgeschlossen: {toLocal(j.closed_at || null)}
                    </div>
                  </div>
                  <span className="pill">
                    <span className="dot" style={{ background: "#30d158" }} />
                    {badge(j.status)}
                  </span>
                </div>
              </a>
            ))}
          </div>
        )}
      </div>

      <div className="muted" style={{ fontSize: 12, marginTop: 14 }}>
        Installation: iPhone Safari → Teilen → „Zum Home-Bildschirm“. Samsung/Chrome → ⋮ → „App installieren“.
      </div>
    </div>
  );
}
