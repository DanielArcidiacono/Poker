import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Screen Viewer Dashboard",
  description: "Start Mac screen sharing from anywhere",
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
