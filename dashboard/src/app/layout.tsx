import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Prostar",
  description: "Manage active Prostar screen-sharing sessions",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
