import "./globals.css";

export const metadata = {
  title: "Utplava",
  description: "Build anywhere. Run here.",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
