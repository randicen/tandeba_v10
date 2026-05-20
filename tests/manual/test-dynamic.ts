async function test() {
  const htmlToDocx = await import("html-to-docx");
  try {
    const fn = htmlToDocx.default || htmlToDocx; // fallback
    const buffer = await fn("<p>Hello dynamic</p>", null, { footer: true });
    console.log("Success with dynamic import, size:", buffer.length);
  } catch(e) {
    console.error("Error dynamically:", e);
  }
}
test();
