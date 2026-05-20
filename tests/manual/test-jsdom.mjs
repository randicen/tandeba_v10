import jsdom from 'jsdom';
const { JSDOM } = jsdom;
const dom = new JSDOM(`<!DOCTYPE html><div contenteditable="true">Hello world</div>`);
const document = dom.window.document;
// execCommand isn't fully supported in jsdom, it might not do exactly what Chrome does...
