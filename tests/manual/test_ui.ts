import axios from "axios";

async function run() {
  try {
    const api = axios.create({ baseURL: 'http://localhost:3000/api' });
    const { data: session } = await api.post('/sessions', { name: "test frontend" });
    console.log("Created: ", session.id);
    
    // Simulate what App.tsx does:
    // sendMessage() =>
    await api.post(`/sessions/${session.id}/message`, { content: "Do a web search for latest AI news." });
    console.log("Message sent");
    
    const { data: res } = await api.post(`/sessions/${session.id}/step`);
    console.log("Step complete:", res.status);
    console.log("Messages so far:", res.messages.map((m: any) => m.role + ': ' + m.content));
  } catch(e: any) {
    if (e.response) {
      console.error("HTTP 500 ERROR CAUGHT:");
      console.error(e.response.status, e.response.data);
    } else {
      console.error("AXIOS ERROR:", e.message);
    }
  }
}
run();
