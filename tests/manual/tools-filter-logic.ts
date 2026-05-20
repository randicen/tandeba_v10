const msg = { role: 'assistant', content: 'test', tool_calls: [{id: '1'}] };
const messages = [msg];
const o: any = { role: msg.role, content: msg.content };
if (msg.tool_calls) {
  const validToolCalls = msg.tool_calls.filter(tc => false);
  if (validToolCalls.length > 0) {
     o.tool_calls = validToolCalls;
  }
}
if (o.role === 'assistant' && !o.content && !o.tool_calls) {
  o.content = '[Omitted]';
}
console.log(o);
