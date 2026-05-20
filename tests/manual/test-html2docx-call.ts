import htmlToDocx from "html-to-docx";

async function test() {
  try {
    const buffer = await htmlToDocx("<p>Hello</p>", null, { table: { row: { cantSplit: true } }, footer: true, pageNumber: true });
    console.log("Success, buffer size:", buffer.length);
  } catch(e) {
    console.error("Error creating docx:", e);
  }
}
test();
