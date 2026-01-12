import type { Metadata } from "next";
import SwRegister from "./sw-register";

export const metadata: Metadata = {
  title: "Pro Automobile",
  description: "Aufträge via QR öffnen und Zeiten starten/stoppen.",
  manifest: "/manifest.webmanifest",
  themeColor: "#c1121f",
  icons: {
    icon: "/icons/icon-192.png",
    apple: "/icons/icon-192.png"
  }
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="de">
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </head>
      <body style={{ fontFamily: "system-ui, Arial", margin: 0, background: "#fff" }}>
        <SwRegister />
        <div style={{ maxWidth: 900, margin: "0 auto", padding: 16 }}>{children}</div>
      </body>
    </html>
  );
}
