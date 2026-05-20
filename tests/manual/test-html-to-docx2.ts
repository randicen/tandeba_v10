process.env.NODE_ENV = 'development';
async function test() {
  const htmlToDocx = await import("html-to-docx");
  console.log(typeof htmlToDocx.default);
  console.log(typeof htmlToDocx);
}
test();
