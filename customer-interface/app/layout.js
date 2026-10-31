import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import "./globals.css";
import { PageAnalytics } from "./page-analytics.js";

export const metadata = {
  title: "Utplava",
  description: "Build anywhere. Run here.",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <body>{children}<PageAnalytics /></body>
    </html>
  );
}
