// ═══════════════════════════════════════════════════════════════
//  AutoPilot AI — Unified Backend Server v4.0 (Production)
//  Platforms: Instagram · WhatsApp · Facebook Messenger · Web Chat
//  AI: Groq · Claude · Gemini — auto-detected per client
//  Persistent storage — survives server restarts
// ═══════════════════════════════════════════════════════════════
const express = require('express');
const axios   = require('axios');
const cors    = require('cors');
const fs      = require('fs');
const path    = require('path');
const app     = express();

// Security headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  // Force HTTPS redirect
  if (req.headers['x-forwarded-proto'] === 'http') {
    return res.redirect(301, 'https://' + req.get('host') + req.url);
  }
  next();
});

app.use(cors({
  origin: ['https://autopilotaiindia.netlify.app', 'https://*.netlify.app', 'https://*.onrender.com'],
  methods: ['GET', 'POST'],
  credentials: true
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── CONFIG ─────────────────────────────────────────────────────
const VERIFY_TOKEN    = process.env.VERIFY_TOKEN    || 'autopilot_secret_123';
const GROQ_API_KEY    = process.env.GROQ_API_KEY    || '';
const GEMINI_API_KEY  = process.env.GEMINI_API_KEY  || '';
const CLAUDE_API_KEY  = process.env.CLAUDE_API_KEY  || '';
const META_APP_ID     = process.env.META_APP_ID     || '';
const META_APP_SECRET = process.env.META_APP_SECRET || '';
const DATA_FILE      = path.join(__dirname, 'clients_data.json');
// ───────────────────────────────────────────────────────────────

// ══════════════════════════════════════════════════════════════
//  PERSISTENT STORAGE — reads/writes clients_data.json
// ══════════════════════════════════════════════════════════════
function loadClients() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, 'utf8');
      return JSON.parse(raw);
    }
  } catch (e) {
    console.error('[STORAGE] Load error:', e.message);
  }
  return {};
}

function saveClients() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(clients, null, 2), 'utf8');
  } catch (e) {
    console.error('[STORAGE] Save error:', e.message);
  }
}

// Load clients from disk on startup
const clients = loadClients();
console.log(`[STORAGE] Loaded ${Object.keys(clients).length} client(s) from disk`);

// Auto-cleanup: remove duplicate clients with same ig_acct_id
(function cleanupDuplicates() {
  const seen = {};
  const toDelete = [];
  Object.entries(clients).forEach(([id, c]) => {
    const acctId = c.ig?.ig_acct_id;
    if (acctId) {
      if (seen[acctId]) {
        // Keep the longer named one, delete shorter
        toDelete.push(id.length < seen[acctId].length ? id : seen[acctId]);
        seen[acctId] = id.length > seen[acctId].length ? id : seen[acctId];
      } else {
        seen[acctId] = id;
      }
    }
  });
  if (toDelete.length > 0) {
    toDelete.forEach(id => { delete clients[id]; });
    saveClients();
    console.log('[CLEANUP] Removed duplicate clients:', toDelete);
  }
})();

// Conversation memory (in-memory only — resets on restart, that's fine)
const memory = {};

function getHistory(clientId, userId) {
  const key = clientId + '_' + userId;
  if (!memory[key]) memory[key] = [];
  return memory[key];
}
function addToHistory(clientId, userId, role, content) {
  const key = clientId + '_' + userId;
  if (!memory[key]) memory[key] = [];
  memory[key].push({ role, content });
  if (memory[key].length > 20) memory[key] = memory[key].slice(-20);
}

// ══════════════════════════════════════════════════════════════
//  /oauth/callback — Meta redirects here after client logs in
// ══════════════════════════════════════════════════════════════
app.get('/oauth/callback', async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    return res.send('<script>window.opener&&window.opener.postMessage({type:"oauth_error",error:"'+error+'"},"*");window.close();</script>');
  }

  if (!code || !state) {
    return res.send('<script>window.close();</script>');
  }

  try {
    const stateData = JSON.parse(decodeURIComponent(state));
    const { plat, cid, back } = stateData;

    // Exchange code for access token
    const redirectUri = encodeURIComponent(req.protocol + '://' + req.get('host') + '/oauth/callback');
    const tokenUrl = `https://graph.facebook.com/v19.0/oauth/access_token?client_id=${META_APP_ID}&client_secret=${META_APP_SECRET}&code=${code}&redirect_uri=${redirectUri}`;

    const tokenRes = await axios.get(tokenUrl);
    const accessToken = tokenRes.data.access_token;

    // Get user info
    const meRes = await axios.get(`https://graph.facebook.com/v19.0/me?fields=id,name&access_token=${accessToken}`);
    const { id, name } = meRes.data;

    // For Instagram — get Instagram business account
    let igAcctId = id;
    if (plat === 'ig') {
      try {
        const pagesRes = await axios.get(`https://graph.facebook.com/v19.0/me/accounts?access_token=${accessToken}`);
        const pages = pagesRes.data.data || [];
        if (pages.length > 0) {
          const igRes = await axios.get(`https://graph.facebook.com/v19.0/${pages[0].id}?fields=instagram_business_account&access_token=${accessToken}`);
          igAcctId = igRes.data.instagram_business_account?.id || id;
        }
      } catch(e) { /* use fallback */ }
    }

    // Save to client registry
    if (!clients[cid]) clients[cid] = { systemPrompt: '' };
    clients[cid][plat] = {
      [plat + '_token']:    accessToken,
      [plat + '_acct_id']: igAcctId,
      [plat + '_page_id']: id,
      [plat + '_name']:    name,
    };
    saveClients();

    console.log(`[OAUTH] ${plat.toUpperCase()} connected for client ${cid} — ${name}`);

    // Send token back to client bot via postMessage then close popup
    res.send(`<!DOCTYPE html><html><body>
      <p style="font-family:sans-serif;text-align:center;padding:40px;color:#22c55e">
        ✅ ${name} connected! This window will close...
      </p>
      <script>
        // Save token to client bot localStorage via opener
        try {
          var saved = JSON.parse(localStorage.getItem('cb_keys_${cid}') || '{}');
          saved['${plat}'] = {
            '${plat}_token': '${accessToken}',
            '${plat}_acct_id': '${igAcctId}',
            '${plat}_name': '${name}'
          };
          localStorage.setItem('cb_keys_${cid}', JSON.stringify(saved));
        } catch(e) {}
        if(window.opener) {
          window.opener.postMessage({type:'oauth_done',plat:'${plat}',name:'${name}'},'*');
        }
        setTimeout(function(){ window.close(); }, 1500);
      </script>
    </body></html>`);

  } catch(err) {
    console.error('[OAUTH] Error:', err.response?.data || err.message);
    res.send('<script>alert("Connection failed: ' + (err.message||'unknown') + '");window.close();</script>');
  }
});

// ══════════════════════════════════════════════════════════════
//  /register — auto-called by client bot when they save keys
// ══════════════════════════════════════════════════════════════
app.post('/register', (req, res) => {
  const { clientId, platform, keys, systemPrompt } = req.body;
  if (!clientId || !platform || !keys)
    return res.status(400).json({ ok: false, error: 'Missing fields' });

  if (!clients[clientId]) clients[clientId] = { systemPrompt: '' };
  clients[clientId][platform] = keys;
  // Store page_id as acct_id fallback for Instagram
  if (platform === 'ig' && keys.ig_page_id && !keys.ig_acct_id) {
    clients[clientId][platform].ig_acct_id = keys.ig_page_id;
  }
  if (systemPrompt) clients[clientId].systemPrompt = systemPrompt;

  // Save to disk immediately
  saveClients();

  console.log(`[REGISTER] Client: ${clientId} | Platform: ${platform} | Saved to disk ✓`);
  res.json({ ok: true, message: `${platform} registered for ${clientId}` });
});

// ══════════════════════════════════════════════════════════════
//  /unregister — called when client is deleted from admin panel
// ══════════════════════════════════════════════════════════════
app.post('/unregister', (req, res) => {
  const { clientId } = req.body;
  if (!clientId) return res.status(400).json({ ok: false, error: 'Missing clientId' });
  if (clients[clientId]) {
    delete clients[clientId];
    saveClients();
    console.log(`[UNREGISTER] Client ${clientId} removed from disk ✓`);
  }
  res.json({ ok: true });
});

// ══════════════════════════════════════════════════════════════
//  AI REPLY — Groq → Claude → Gemini (priority order)
// ══════════════════════════════════════════════════════════════
async function getAIReply(clientId, userId, userMessage, platform) {
  const client   = clients[clientId] || {};
  const platKeys = (platform && client[platform]) ? client[platform] : {};
  const prompt = client.systemPrompt ||
    'You are an intelligent, friendly AI assistant for a business. You work like a smart human sales rep.\n' +
    'HOW TO RESPOND:\n' +
    '- UNDERSTAND the message fully before replying\n' +
    '- Give HELPFUL, ACCURATE answers — not generic filler\n' +
    '- If someone asks a question, ANSWER IT properly first\n' +
    '- Match reply length to the question — detailed question gets proper explanation\n' +
    '- Sound human and natural, not robotic\n' +
    'LEAD CAPTURE (naturally, not forcefully):\n' +
    '- After 2-3 exchanges, ask once: "Would you like full details? Drop your number or email"\n' +
    '- If they say no — keep helping, try again later naturally\n' +
    'AVOID: saying "I am an AI", one-word replies, ignoring questions, being pushy\n' +
    'IF UNSURE: Say "I am not sure, but I can connect you with our team who will know. Want me to arrange that?"';

  addToHistory(clientId, userId, 'user', userMessage);
  const history = getHistory(clientId, userId);

  // Pick AI key — Groq first (free), then Claude, then Gemini
  // Client's own keys first, then server fallbacks (Groq FREE → Claude)
  const groqKey   = platKeys.ig_groq_key   || platKeys.fb_groq_key   || platKeys.wa_groq_key   || GROQ_API_KEY;
  const claudeKey = platKeys.ig_claude_key || platKeys.fb_claude_key || platKeys.wa_claude_key || CLAUDE_API_KEY;
  const geminiKey = platKeys.ig_gemini_key || platKeys.fb_gemini_key || platKeys.wa_gemini_key || GEMINI_API_KEY;

  let reply = '';

  try {
    if (groqKey) {
      console.log(`[AI] Groq → ${clientId}`);
      const res = await axios.post(
        'https://api.groq.com/openai/v1/chat/completions',
        {
          model: 'llama-3.3-70b-versatile',
          max_tokens: 700,
          messages: [{ role: 'system', content: prompt }, ...history],
        },
        { headers: { 'Authorization': `Bearer ${groqKey}`, 'Content-Type': 'application/json' } }
      );
      reply = res.data.choices?.[0]?.message?.content || '';

    } else if (claudeKey) {
      console.log(`[AI] Claude → ${clientId}`);
      const res = await axios.post(
        'https://api.anthropic.com/v1/messages',
        { model: 'claude-sonnet-4-20250514', max_tokens: 700, system: prompt, messages: history },
        { headers: { 'x-api-key': claudeKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' } }
      );
      reply = res.data.content?.[0]?.text || '';

    } else if (geminiKey) {
      console.log(`[AI] Gemini → ${clientId}`);
      const gmMsgs = history.map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }]
      }));
      gmMsgs.unshift(
        { role: 'user',  parts: [{ text: '[INSTRUCTIONS] ' + prompt }] },
        { role: 'model', parts: [{ text: 'Understood.' }] }
      );
      const res = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${geminiKey}`,
        { contents: gmMsgs, generationConfig: { maxOutputTokens: 700 } },
        { headers: { 'Content-Type': 'application/json' } }
      );
      reply = res.data.candidates?.[0]?.content?.parts?.[0]?.text || '';

    } else {
      reply = 'I am not configured yet. Please contact support.';
    }

    if (!reply) reply = 'Sorry, I had trouble responding. Please try again!';
    addToHistory(clientId, userId, 'assistant', reply);
    return reply;

  } catch (err) {
    console.error(`[AI] Error:`, err.response?.data || err.message);
    return 'Sorry, I am having trouble right now. Please try again in a moment!';
  }
}

// ══════════════════════════════════════════════════════════════
//  PLATFORM SENDERS
// ══════════════════════════════════════════════════════════════
async function sendInstagram(token, recipientId, text, igAcctId, pageId) {
  // Try multiple endpoints for Instagram messaging
  const endpoints = [
    pageId   ? `https://graph.facebook.com/v19.0/${pageId}/messages`   : null,
    igAcctId ? `https://graph.facebook.com/v19.0/${igAcctId}/messages` : null,
    'https://graph.facebook.com/v19.0/me/messages',
  ].filter(Boolean);

  let lastErr = null;
  for (const endpoint of endpoints) {
    try {
      await axios.post(
        endpoint,
        { recipient: { id: recipientId }, message: { text } },
        { params: { access_token: token } }
      );
      console.log('[IG] Sent via:', endpoint);
      return;
    } catch(e) {
      lastErr = e;
      console.log('[IG] Endpoint failed:', endpoint, e.response?.data?.error?.message);
    }
  }
  throw lastErr;
}

async function sendFacebook(token, recipientId, text) {
  await axios.post(
    'https://graph.facebook.com/v19.0/me/messages',
    { recipient: { id: recipientId }, message: { text }, messaging_type: 'RESPONSE' },
    { params: { access_token: token } }
  );
}

async function sendWhatsApp(phoneNumberId, token, to, text) {
  await axios.post(
    `https://graph.facebook.com/v19.0/${phoneNumberId}/messages`,
    { messaging_product: 'whatsapp', to, type: 'text', text: { body: text } },
    { headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' } }
  );
}

function findClient(platform, idField, idValue) {
  return Object.entries(clients).find(([, c]) => c[platform]?.[idField] === idValue)?.[0] || null;
}

// ══════════════════════════════════════════════════════════════
//  WEBHOOK VERIFICATION (Meta)
// ══════════════════════════════════════════════════════════════
app.get('/webhook', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === VERIFY_TOKEN) {
    console.log('[WEBHOOK] Meta verified ✓');
    return res.status(200).send(req.query['hub.challenge']);
  }
  res.sendStatus(403);
});

// ══════════════════════════════════════════════════════════════
//  INSTAGRAM + FACEBOOK MESSAGES
// ══════════════════════════════════════════════════════════════
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  const body = req.body;

  if (body.object === 'instagram') {
    try {
      const entry    = body.entry?.[0];
      const event    = entry?.messaging?.[0];
      if (!event || event.message?.is_echo) return;
      const senderId = event.sender?.id;
      const text     = event.message?.text;
      const acctId   = entry?.id;
      if (!text) return;
      console.log('[IG] acct_id from webhook:', acctId);
      console.log('[IG] Registered clients:', Object.keys(clients));
      Object.entries(clients).forEach(([cid,c])=>{
        if(c.ig) console.log('[IG] Client',cid,'has ig_acct_id:',c.ig.ig_acct_id);
      });
      // Try matching by all possible ID fields
      let clientId = findClient('ig', 'ig_acct_id', acctId);
      if (!clientId) clientId = findClient('ig', 'ig_page_id', acctId);
      // Also try finding ANY client that has an ig token (single client fallback)
      if (!clientId) {
        const igClients = Object.entries(clients).filter(([,c]) => c.ig && c.ig.ig_token);
        if (igClients.length === 1) {
          clientId = igClients[0][0];
          console.log('[IG] Using single registered IG client as fallback:', clientId);
        } else if (igClients.length > 1) {
          // Use the client whose acctId is closest match or just use first one
          clientId = igClients[0][0];
          console.log('[IG] Multiple clients — using first:', clientId);
        }
      }
      // Last resort: use any client with IG token if only one exists
      if (!clientId) {
        const igClients = Object.entries(clients).filter(([,c]) => c.ig && c.ig.ig_token);
        if (igClients.length === 1) {
          clientId = igClients[0][0];
          console.log('[IG] Using fallback single IG client:', clientId);
        } else {
          console.log('[IG] No matching client — webhook acct_id:', acctId);
          return;
        }
      }
      const token = clients[clientId]?.ig?.ig_token;
      if (!token) { console.log('[IG] Token missing for:', clientId); return; }
      console.log(`[IG] "${text}" → client ${clientId}`);
      const reply = await getAIReply(clientId, 'ig_' + senderId, text, 'ig');
      const igAcctId = clients[clientId]?.ig?.ig_acct_id;
      const pageId   = clients[clientId]?.ig?.ig_page_id;
      console.log('[IG] Sending reply using acctId:', igAcctId, 'pageId:', pageId, 'token starts with:', token.substring(0,20));
      await sendInstagram(token, senderId, reply, igAcctId, pageId);
      console.log('[IG] Replied ✓');
    } catch (err) { console.error('[IG]', err.response?.data || err.message); }
  }

  else if (body.object === 'page') {
    try {
      const entry    = body.entry?.[0];
      const event    = entry?.messaging?.[0];
      if (!event || event.message?.is_echo) return;
      const senderId = event.sender?.id;
      const text     = event.message?.text;
      const pageId   = entry?.id;
      if (!text) return;
      const clientId = findClient('fb', 'fb_page_id', pageId);
      if (!clientId) { console.log('[FB] No client for page_id:', pageId); return; }
      const token = clients[clientId]?.fb?.fb_token;
      if (!token) return;
      console.log(`[FB] "${text}" → client ${clientId}`);
      const reply = await getAIReply(clientId, 'fb_' + senderId, text, 'fb');
      await sendFacebook(token, senderId, reply);
      console.log('[FB] Replied ✓');
    } catch (err) { console.error('[FB]', err.response?.data || err.message); }
  }
});

// ══════════════════════════════════════════════════════════════
//  WHATSAPP WEBHOOK
// ══════════════════════════════════════════════════════════════
app.get('/webhook/whatsapp', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === VERIFY_TOKEN) {
    console.log('[WA] Webhook verified ✓');
    return res.status(200).send(req.query['hub.challenge']);
  }
  res.sendStatus(403);
});

app.post('/webhook/whatsapp', async (req, res) => {
  res.sendStatus(200);
  try {
    const value   = req.body?.entry?.[0]?.changes?.[0]?.value;
    if (value?.statuses) return;
    const message = value?.messages?.[0];
    if (!message) return;
    const from    = message.from;
    const text    = message.text?.body;
    const phoneId = value?.metadata?.phone_number_id;
    if (!text) return;
    const clientId = findClient('wa', 'wa_phone_id', phoneId);
    if (!clientId) { console.log('[WA] No client for phone_id:', phoneId); return; }
    const waKeys = clients[clientId]?.wa;
    if (!waKeys?.wa_token) return;
    console.log(`[WA] "${text}" → client ${clientId}`);
    const reply = await getAIReply(clientId, 'wa_' + from, text, 'wa');
    await sendWhatsApp(waKeys.wa_phone_id, waKeys.wa_token, from, reply);
    console.log('[WA] Replied ✓');
  } catch (err) { console.error('[WA]', err.response?.data || err.message); }
});

// ══════════════════════════════════════════════════════════════
//  WEB CHAT API
// ══════════════════════════════════════════════════════════════
app.post('/api/chat', async (req, res) => {
  try {
    const { clientId, sessionId, message } = req.body;
    if (!message) return res.status(400).json({ error: 'message required' });
    const cid   = clientId || 'default';
    const uid   = 'web_' + (sessionId || Math.random().toString(36).substr(2, 8));
    const reply = await getAIReply(cid, uid, message, null);
    res.json({ reply });
  } catch (err) {
    res.status(500).json({ reply: 'Sorry, something went wrong!' });
  }
});

// ══════════════════════════════════════════════════════════════
//  HEALTH CHECK
// ══════════════════════════════════════════════════════════════
// Manual register page — shows a form to safely enter token
app.get('/manual-register', (req, res) => {
  res.send(`<!DOCTYPE html><html><head><title>Register Client</title></head><body style="font-family:sans-serif;padding:30px;max-width:600px">
    <h2>Manual Instagram Registration</h2>
    <form method="POST" action="/manual-register">
      <div style="margin-bottom:15px">
        <label>Client ID:</label><br>
        <input name="clientId" value="autopilot ai" style="width:100%;padding:8px;margin-top:5px">
      </div>
      <div style="margin-bottom:15px">
        <label>Instagram Account ID:</label><br>
        <input name="acctId" value="1784144079865144" style="width:100%;padding:8px;margin-top:5px">
      </div>
      <div style="margin-bottom:15px">
        <label>Access Token (paste full token here):</label><br>
        <textarea name="token" rows="4" style="width:100%;padding:8px;margin-top:5px" placeholder="EAAxxxxx..."></textarea>
      </div>
      <button type="submit" style="background:#6366f1;color:white;padding:10px 20px;border:none;border-radius:6px;cursor:pointer;font-size:16px">Register</button>
    </form>
  </body></html>`);
});

app.post('/manual-register', express.urlencoded({ extended: true }), (req, res) => {
  const { clientId, acctId, token } = req.body;
  if (!clientId || !acctId || !token) {
    return res.json({ error: 'Missing fields' });
  }
  const cleanToken = token.trim();
  // Remove any other client with same acctId to avoid duplicates
  Object.keys(clients).forEach(id => {
    if (id !== clientId && clients[id]?.ig?.ig_acct_id === acctId.trim()) {
      delete clients[id];
      console.log('[MANUAL] Removed duplicate client:', id);
    }
  });
  if (!clients[clientId]) clients[clientId] = { systemPrompt: '' };
  clients[clientId]['ig'] = {
    ig_acct_id: acctId.trim(),
    ig_token: cleanToken,
    ig_page_id: acctId.trim()
  };
  saveClients();
  console.log('[MANUAL] Registered', clientId, 'with ig_acct_id:', acctId.trim(), 'token length:', cleanToken.length);
  res.send(`<!DOCTYPE html><html><body style="font-family:sans-serif;padding:30px">
    <h2 style="color:green">✅ Registered Successfully!</h2>
    <p>Client: <strong>${clientId}</strong></p>
    <p>Account ID: <strong>${acctId}</strong></p>
    <p>Token length: <strong>${cleanToken.length} characters</strong></p>
    <p style="color:green">Now ask your friend to send a message on Instagram!</p>
    <a href="/manual-register">Register another</a>
  </body></html>`);
});

app.get('/', (req, res) => {
  const registered = Object.keys(clients);
  res.json({
    service  : 'AutoPilot AI — Backend Server v4.0',
    status   : '✅ Running',
    storage  : '✅ Persistent (survives restarts)',
    ai_support : ['Groq (Llama 3.3) — priority 1', 'Claude — priority 2', 'Gemini — priority 3'],
    webhooks : {
      instagram_facebook : 'GET/POST /webhook',
      whatsapp           : 'GET/POST /webhook/whatsapp',
      web_chat           : 'POST /api/chat',
      register           : 'POST /register',
      unregister         : 'POST /unregister',
    },
    registered_clients: registered.length
      ? registered.map(id => ({
          id,
          platforms: Object.keys(clients[id]).filter(k => k !== 'systemPrompt'),
        }))
      : 'None yet — clients register automatically when they save API keys',
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 AutoPilot AI Server v4.0 running on port ${PORT}`);
  console.log(`💾 Persistent storage: ${DATA_FILE}`);
  console.log(`📍 Visit your Render URL to check status\n`);
});
