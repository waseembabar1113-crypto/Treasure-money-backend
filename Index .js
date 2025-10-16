require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const Database = require('better-sqlite3');
const fetch = require('node-fetch'); // if using node-fetch v2
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(bodyParser.json());
app.use(cors());

// simple sqlite DB (file: data.db)
const db = new Database('./data.db');
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT,
  name TEXT,
  balance INTEGER DEFAULT 0,
  ref_code TEXT,
  created_at INTEGER
);
CREATE TABLE IF NOT EXISTS deposits (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  method TEXT,
  amount_pkr INTEGER,
  coins INTEGER,
  tx_id TEXT,
  status TEXT,
  created_at INTEGER
);
CREATE TABLE IF NOT EXISTS withdraws (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  method TEXT,
  account TEXT,
  amount INTEGER,
  status TEXT,
  created_at INTEGER
);
`);

// helper to convert PKR->coins (demo 1 PKR = 1 coin)
function pkrToCoins(pkr){ return Math.floor(pkr); }

// ---------- Endpoint: create payment (frontend calls this to get a payment link) ----------
app.post('/api/create-payment', async (req, res) => {
  // expected body: { userId, amountPKR, method }  (method: 'jazzcash'|'easypaisa')
  try {
    const { userId, amountPKR, method } = req.body;
    if(!userId || !amountPKR || !method) return res.status(400).json({ error: 'Missing fields' });

    // create deposit record with status 'initiated'
    const depositId = uuidv4();
    const coins = pkrToCoins(amountPKR);
    const createdAt = Date.now();
    const insert = db.prepare('INSERT INTO deposits (id,user_id,method,amount_pkr,coins,tx_id,status,created_at) VALUES (?,?,?,?,?,?,?,?)');
    insert.run(depositId, userId, method, amountPKR, coins, null, 'initiated', createdAt);

    // --- HERE: call JazzCash API to create payment request ---
    // This is a placeholder: you will need to replace this with actual JazzCash API call
    // using keys from process.env and the merchant API docs.
    // For now we return a simulated payment url that your frontend can open.
    const fakePaymentUrl = `${req.protocol}://${req.get('host')}/mock-pay?depositId=${depositId}`;

    return res.json({
      ok: true,
      depositId,
      paymentUrl: fakePaymentUrl,
      message: 'Use a real JazzCash API call here when you have merchant keys.'
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'server error' });
  }
});

// Mock pay page (for demo testing)
app.get('/mock-pay', (req,res) => {
  const depositId = req.query.depositId;
  // simple HTML payment simulator
  res.send(`
    <html><body style="font-family:Arial;padding:20px">
      <h2>Demo Payment Page</h2>
      <p>Deposit ID: ${depositId}</p>
      <p>This simulates a JazzCash/Easypaisa payment (demo only).</p>
      <form method="POST" action="/mock-complete">
        <input type="hidden" name="depositId" value="${depositId}" />
        <label>Transaction ID (any text): <input name="tx" /></label><br/><br/>
        <button type="submit">Simulate Payment Success</button>
      </form>
    </body></html>
  `);
});

// Mock complete (simulate webhook notifying server of success)
app.post('/mock-complete', bodyParser.urlencoded({ extended: true }), (req,res) => {
  const depositId = req.body.depositId;
  const tx = req.body.tx || 'MOCKTX'+Math.floor(Math.random()*10000);
  // mark deposit approved
  const dep = db.prepare('SELECT * FROM deposits WHERE id=?').get(depositId);
  if(!dep) return res.send('Deposit not found');
  db.prepare('UPDATE deposits SET tx_id=?, status=? WHERE id=?').run(tx, 'approved', depositId);
  // credit user's balance
  db.prepare('UPDATE users SET balance = balance + ? WHERE id=?').run(dep.coins, dep.user_id);
  res.send(`<html><body>Payment recorded. You can close this tab. <br/>Tx: ${tx}</body></html>`);
});

// Webhook endpoint (JazzCash will POST here in real integration)
app.post('/api/webhook', (req,res) => {
  // Verify webhook signature with process.env.WEBHOOK_SECRET if provided
  // Process payload from JazzCash and update deposit record
  // Example placeholder:
  const payload = req.body;
  // expected payload sample: { depositId, txId, status, amountPKR, method }
  if(!payload || !payload.depositId) return res.status(400).end('bad payload');
  const dep = db.prepare('SELECT * FROM deposits WHERE id=?').get(payload.depositId);
  if(!dep) return res.status(404).end('not found');
  if(payload.status === 'success'){
    db.prepare('UPDATE deposits SET tx_id=?, status=? WHERE id=?').run(payload.txId||'N/A','approved', payload.depositId);
    db.prepare('UPDATE users SET balance = balance + ? WHERE id=?').run(dep.coins, dep.user_id);
  } else {
    db.prepare('UPDATE deposits SET status=? WHERE id=?').run('failed', payload.depositId);
  }
  res.json({ ok:true });
});

// Create test user (for demo)
// In production you'd implement auth and create user properly
app.post('/api/create-user', (req,res) => {
  const { email, name } = req.body;
  if(!email) return res.status(400).json({ error:'email required' });
  const id = uuidv4();
  const ref = id.slice(0,7).toUpperCase();
  db.prepare('INSERT INTO users (id,email,name,balance,ref_code,created_at) VALUES (?,?,?,?,?,?)').run(id,email,name||email,0,ref,Date.now());
  res.json({ ok:true, userId:id, refCode:ref });
});

// get user
app.get('/api/user/:id', (req,res) => {
  const u = db.prepare('SELECT id,email,name,balance,ref_code,created_at FROM users WHERE id=?').get(req.params.id);
  if(!u) return res.status(404).json({ error:'not found' });
  res.json(u);
});

// withdraw request
app.post('/api/withdraw', (req,res) => {
  const { userId, method, account, amount } = req.body;
  if(!userId || !method || !account || !amount) return res.status(400).json({ error:'missing' });
  const id = uuidv4();
  db.prepare('INSERT INTO withdraws (id,user_id,method,account,amount,status,created_at) VALUES (?,?,?,?,?,?,?)')
    .run(id,userId,method,account,amount,'pending',Date.now());
  // deduct balance immediately or on approval as per your flow (here we deduct)
  db.prepare('UPDATE users SET balance = balance - ? WHERE id=?').run(amount, userId);
  res.json({ ok:true, withdrawId:id });
});

// start server
const PORT = process.env.PORT || 8080;
app.listen(PORT, ()=> console.log('Server listening on', PORT));
