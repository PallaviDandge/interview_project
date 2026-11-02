import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "Interview Copilot POC",
  description: "Real-time interview transcription and answer assistant",
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
