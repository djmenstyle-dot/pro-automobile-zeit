import type { Metadata } from "next";
import "./globals.css";
import SwRegister from "./sw-register";

export const metadata: Metadata = {
  title: "Pro Automobile",
  description: "Aufträge via QR öffnen und Zeiten starten/stoppen.",
  manifest: "/manifest.webmanifest",
  themeColor: "#c1121f",
  icons: {
    icon: "/icons/icon-192.png",
    apple: "/icons/icon-192.png",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="de">
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </head>
      <body>
        <SwRegister />
        <div className="container">{children}</div>
      </body>
    </html>
  );
}
