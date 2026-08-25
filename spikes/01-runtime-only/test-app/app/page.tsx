export default function Home() {
  const marker = process.env.APP_BUILD_MARKER ?? "marker-not-configured";

  return (
    <main style={{ fontFamily: "system-ui, sans-serif", maxWidth: 720, margin: "80px auto", padding: 24 }}>
      <p>Small Software Cloud</p>
      <h1>Spike A Runtime Test</h1>
      <p>This application exists only to prove programmatic deployment.</p>
      <p><strong>Build marker:</strong> {marker}</p>
    </main>
  );
}
