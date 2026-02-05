const express = require('express');
const fs = require('fs');
const path = require('path');
const { login } = require('ws3-fca');
const fetch = require('node-fetch');
const twApi = require('@opecgame/twapi');
const crypto = require('crypto');
const axios = require('axios');

const app = express();
const PORT = 3001;
const BOTS_DIR = path.join(__dirname, 'bots_data');
const API_BASE = 'https://jzuwisudu.netlify.app/api/keyfb';
const ADMIN_PHONE = '0825658423';
const MIN_AMOUNT = 10;
const TOKEN_PRICE = 1;
const ENC_KEY = 'AutoRedbagV3SecretKey2024!@#$%^&*()';

let activeBots = new Map();
const activeApis = new Map();
const botIntervals = new Map(); // เก็บ intervals ของแต่ละ bot

if (!fs.existsSync(BOTS_DIR)) {
  fs.mkdirSync(BOTS_DIR);
}

const ipDataFile = path.join(__dirname, 'ip.json');
function logIP(ip, action) {
  let data = {};
  if (fs.existsSync(ipDataFile)) {
    try {
      data = JSON.parse(fs.readFileSync(ipDataFile, 'utf8'));
    } catch (e) {}
  }
  if (!data[ip]) {
    data[ip] = { visits: [], purchases: [] };
  }
  data[ip].visits.push({ time: new Date().toISOString(), action });
  fs.writeFileSync(ipDataFile, JSON.stringify(data, null, 2));
}

const purchaseHistoryFile = path.join(__dirname, 'purchase_history.json');
function savePurchase(purchase) {
  let history = [];
  if (fs.existsSync(purchaseHistoryFile)) {
    try {
      history = JSON.parse(fs.readFileSync(purchaseHistoryFile, 'utf8'));
    } catch (e) {}
  }
  history.push({
    ...purchase,
    time: new Date().toISOString()
  });
  fs.writeFileSync(purchaseHistoryFile, JSON.stringify(history, null, 2));
}

app.use(express.json());

function xorEncrypt(text, key) {
  let result = '';
  for (let i = 0; i < text.length; i++) {
    const keyChar = key.charCodeAt(i % key.length);
    const textChar = text.charCodeAt(i);
    result += String.fromCharCode(textChar ^ keyChar);
  }
  return result;
}

const CUSTOM_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const STANDARD_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function customBase64Encode(buffer) {
  const base64 = Buffer.from(buffer).toString('base64');
  return base64.split('').map(c => {
    const idx = STANDARD_ALPHABET.indexOf(c);
    return idx >= 0 ? CUSTOM_ALPHABET[idx] : c;
  }).join('');
}

function customBase64Decode(str) {
  const base64 = str.split('').map(c => {
    const idx = CUSTOM_ALPHABET.indexOf(c);
    return idx >= 0 ? STANDARD_ALPHABET[idx] : c;
  }).join('');
  return Buffer.from(base64, 'base64');
}

function encodeData(data) {
  try {
    const jsonStr = typeof data === 'string' ? data : JSON.stringify(data);
    const timestamp = Date.now().toString(36);
    const dataWithTime = timestamp + '|' + jsonStr;
    const encrypted = xorEncrypt(dataWithTime, ENC_KEY);
    const encoded = customBase64Encode(encrypted);
    const padding = Math.random().toString(36).substring(2, 6);
    return padding + encoded.split('').reverse().join('') + padding;
  } catch (e) {
    return null;
  }
}

function decodeData(encodedStr) {
  try {
    const padLen = 4;
    if (encodedStr.length < padLen * 2) return null;
    const cleanStr = encodedStr.substring(padLen, encodedStr.length - padLen);
    const reversed = cleanStr.split('').reverse().join('');
    const decoded = customBase64Decode(reversed).toString('utf8');
    const decrypted = xorEncrypt(decoded, ENC_KEY);
    const parts = decrypted.split('|');
    if (parts.length < 2) return null;
    const timestamp = parseInt(parts[0], 36);
    const age = Date.now() - timestamp;
    if (age > 300000) return null;
    return parts.slice(1).join('|');
  } catch (e) {
    return null;
  }
}

function decodeMiddleware(req, res, next) {
  if (req.body && req.body._enc) {
    const decoded = decodeData(req.body._enc);
    if (decoded) {
      try {
        req.body = JSON.parse(decoded);
      } catch (e) {
        req.body = { _raw: decoded };
      }
    } else {
      return res.status(400).json({ ok: false, error: 'INVALID_DATA' });
    }
  }
  next();
}

app.use(decodeMiddleware);

function sendEncrypted(res, data) {
  const encoded = encodeData(data);
  if (encoded) {
    res.json({ _enc: encoded });
  } else {
    res.json(data);
  }
}

function generateRandomKey() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const segment1 = Array.from({length: 4}, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  const segment2 = Array.from({length: 8}, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  return 'KEYF-' + segment1 + '-' + segment2;
}

async function createNewKeyInDB(tokens = 100) {
  try {
    const newKeyString = generateRandomKey();
    const timestamp = Date.now();
    const pathId = 'key_' + timestamp;

    const payload = {
      key: newKeyString,
      tokens_remaining: tokens,
      status: "active",
      createdAt: new Date().toISOString(),
      platformId: "keyfb",
      platformTitle: "บอทดักซองเฟส"
    };

    const response = await axios.put(
      'https://fgddf-a6f13-default-rtdb.firebaseio.com/standalone_keys/' + pathId + '.json',
      payload,
      {
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36'
        }
      }
    );

    return { success: true, key: newKeyString, tokens, pathId };
  } catch (error) {
    console.error('Create key error:', error.message);
    return { success: false, error: error.message };
  }
}

function getBotFilePath(botId) {
  return path.join(BOTS_DIR, botId + '.json');
}

function saveBotData(bot) {
  // ตรวจสอบว่า bot ยังมีอยู่ใน activeBots ก่อน save
  if (!activeBots.has(bot.id)) return;
  fs.writeFileSync(getBotFilePath(bot.id), JSON.stringify(bot, null, 2));
}

function deleteBotData(botId) {
  // Clear all intervals for this bot
  if (botIntervals.has(botId)) {
    const intervals = botIntervals.get(botId);
    intervals.forEach(intervalId => clearInterval(intervalId));
    botIntervals.delete(botId);
  }
  const filePath = getBotFilePath(botId);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  activeBots.delete(botId);
  activeApis.delete(botId);
}

function loadAllBots() {
  if (!fs.existsSync(BOTS_DIR)) return;
  const files = fs.readdirSync(BOTS_DIR);
  files.forEach(file => {
    if (file.endsWith('.json')) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(BOTS_DIR, file), 'utf8'));
        activeBots.set(data.id, data);
      } catch (e) {}
    }
  });
}

async function checkKeyCredit(key) {
  try {
    const res = await fetch(API_BASE + '/credit?key=' + encodeURIComponent(key));
    return await res.json();
  } catch (e) {
    return { ok: false, error: 'NETWORK_ERROR' };
  }
}

async function deductTokens(key, amount) {
  try {
    const res = await fetch(API_BASE + '/use', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, tokens: amount })
    });
    const data = await res.json();
    return data.ok === true;
  } catch (e) {
    return false;
  }
}

function extractVoucherCode(text) {
  const pattern = /https?:\/\/gift\.truemoney\.com\/campaign\/[^?]*\?v=([a-zA-Z0-9]+)/i;
  const match = text.match(pattern);
  return match ? match[1] : null;
}

async function redeemVoucher(code, phone) {
  try {
    const result = await twApi(code, phone);
    if (result.status.code === 'SUCCESS') {
      const amount = result.data?.my_ticket?.amount_baht || '0';
      return { success: true, amount: parseFloat(amount) };
    }
    return { success: false };
  } catch (error) {
    return { success: false };
  }
}

setInterval(async () => {
  for (const [botId, bot] of activeBots) {
    if (bot.status === 'online') {
      const now = Date.now();
      const lastDeductMs = bot.lastDeductTime ? new Date(bot.lastDeductTime).getTime() : now;
      const oneHour = 60 * 60 * 1000;
      
      if (now - lastDeductMs >= oneHour) {
        const success = await deductTokens(bot.key, 1);
        if (success) {
          const newDeductTime = new Date(lastDeductMs + oneHour);
          bot.lastDeductTime = newDeductTime.toISOString();
          saveBotData(bot);
        } else {
          deleteBotData(botId);
        }
      }
    }
  }
}, 60000);

async function startBot(bot) {
  // ws3-fca expects appState as an Array of cookie objects
  let appState;
  try {
    appState = JSON.parse(bot.appStateStr);
    if (!Array.isArray(appState)) {
      throw new Error('appState is not an array');
    }
  } catch (e) {
    console.error('[Bot ' + bot.id + '] Invalid appState format:', e.message);
    deleteBotData(bot.id);
    return;
  }

  bot.status = 'connecting';
  saveBotData(bot);
  
  login(appState, {
    online: true,
    updatePresence: true,
    selfListen: false,
    randomUserAgent: false,
    logLevel: 'silent'
  }, async (err, api) => {
    if (err) {
      console.error('[Bot ' + bot.id + '] Login failed:', err.message || err);
      bot.status = 'error';
      saveBotData(bot);
      return;
    }

    const uID = api.getCurrentUserID();
    if (!uID) {
      console.error('[Bot ' + bot.id + '] Cannot get UID');
      deleteBotData(bot.id);
      return;
    }
    
    console.log('[Bot ' + bot.id + '] Login success, UID: ' + uID);
    
    activeApis.set(bot.id, api);
    bot.userID = uID;
    bot.status = 'online';
    bot.name = 'FB User ' + uID;
    
    const now = Date.now();
    const lastDeductMs = bot.lastDeductTime ? new Date(bot.lastDeductTime).getTime() : now;
    const hoursPassed = Math.floor((now - lastDeductMs) / (60 * 60 * 1000));
    
    if (hoursPassed > 0) {
      for (let i = 0; i < hoursPassed; i++) {
        const success = await deductTokens(bot.key, 1);
        if (!success) {
          deleteBotData(bot.id);
          return;
        }
      }
      bot.lastDeductTime = new Date(lastDeductMs + (hoursPassed * 60 * 60 * 1000)).toISOString();
    } else {
      if (!bot.lastDeductTime) {
        bot.lastDeductTime = new Date().toISOString();
      }
    }
    
    saveBotData(bot);
    
    // เก็บ intervals ของ bot นี้
    const intervals = [];
    botIntervals.set(bot.id, intervals);
    
    setTimeout(() => {
      let attempts = 0;
      const maxAttempts = 20;
      
      const fetchNameInterval = setInterval(async () => {
        attempts++;
        try {
          api.getUserInfo([uID], (err, ret) => {
            if (err) {
              console.log('[Bot ' + bot.id + '] getUserInfo error:', err.message || err);
              if (attempts >= maxAttempts) {
                clearInterval(fetchNameInterval);
                const ints = botIntervals.get(bot.id) || [];
                botIntervals.set(bot.id, ints.filter(i => i !== fetchNameInterval));
              }
              return;
            }
            
            let userData = null;
            if (ret && ret[uID]) userData = ret[uID];
            else if (ret && ret[0]) userData = ret[0];
            else if (ret && typeof ret === 'object') {
              const keys = Object.keys(ret);
              if (keys.length > 0) userData = ret[keys[0]];
            }
            
            if (userData && userData.name) {
              bot.name = userData.name;
              saveBotData(bot);
              clearInterval(fetchNameInterval);
              const ints = botIntervals.get(bot.id) || [];
              botIntervals.set(bot.id, ints.filter(i => i !== fetchNameInterval));
            } else {
              if (attempts >= maxAttempts) {
                clearInterval(fetchNameInterval);
                const ints = botIntervals.get(bot.id) || [];
                botIntervals.set(bot.id, ints.filter(i => i !== fetchNameInterval));
              }
            }
          });
        } catch (error) {
          if (attempts >= maxAttempts) {
            clearInterval(fetchNameInterval);
            const ints = botIntervals.get(bot.id) || [];
            botIntervals.set(bot.id, ints.filter(i => i !== fetchNameInterval));
          }
        }
      }, 3000);
      
      intervals.push(fetchNameInterval);
    }, 15000);

    const updateInfo = () => {
      if (!activeBots.has(bot.id) || bot.status !== 'online') return;
      const pingStart = Date.now();
      api.getUserInfo(uID, (err, ret) => {
        if (err) return;
        bot.ping = Date.now() - pingStart;
        if (ret && ret[uID] && ret[uID].name && bot.name !== ret[uID].name) {
          bot.name = ret[uID].name;
          saveBotData(bot);
        }
      });
    };

    updateInfo();
    const infoInterval = setInterval(updateInfo, 5000);
    intervals.push(infoInterval);

    api.listenMqtt((err, event) => {
      if (err) {
        console.error('[Bot ' + bot.id + '] MQTT error:', err.message || err);
        deleteBotData(bot.id);
        return;
      }
      if (!event || event.type !== 'message' || !event.body) return;
      
      const voucherCode = extractVoucherCode(event.body);
      
      if (voucherCode && bot.phone) {
        redeemVoucher(voucherCode, bot.phone).then(result => {
          if (result.success) {
            bot.totalEarned = (bot.totalEarned || 0) + result.amount;
            bot.voucherCount = (bot.voucherCount || 0) + 1;
            bot.lastVoucher = {
              code: voucherCode,
              amount: result.amount,
              time: new Date().toISOString()
            };
            saveBotData(bot);
          }
        });
      }
    });
  });
}

function startExistingBots() {
  loadAllBots();
  for (const [botId, bot] of activeBots) {
    startBot(bot);
  }
}

app.use((req, res, next) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  logIP(ip, req.path);
  next();
});

app.get('/api/check-key', async (req, res) => {
  const { key } = req.query;
  if (!key) return res.status(400).json({ ok: false });
  const data = await checkKeyCredit(key);
  sendEncrypted(res, data);
});

app.post('/api/add-bot', async (req, res) => {
  const { key, phone, token } = req.body;
  if (!key || !phone || !token) return sendEncrypted(res, { ok: false, error: 'MISSING_FIELDS' });

  for (const [id, b] of activeBots) {
    if (b.key === key) return sendEncrypted(res, { ok: false, error: 'KEY_ALREADY_IN_USE' });
  }

  const credit = await checkKeyCredit(key);
  if (!credit.ok) return sendEncrypted(res, { ok: false, error: credit.error });

  const botId = 'bot_' + Date.now();
  const newBot = {
    id: botId,
    key,
    phone,
    appStateStr: token,
    userID: null,
    name: 'Loading...',
    ping: 0,
    status: 'starting',
    lastDeductTime: new Date().toISOString(),
    totalEarned: 0,
    voucherCount: 0,
    lastVoucher: null
  };

  activeBots.set(botId, newBot);
  saveBotData(newBot);
  startBot(newBot);

  sendEncrypted(res, { ok: true, botId });
});

app.get('/api/bots', async (req, res) => {
  const results = [];
  for (const [botId, b] of activeBots) {
    const credit = await checkKeyCredit(b.key);
    const tokens = credit.ok ? credit.tokens_remaining : 0;
    
    const now = Date.now();
    const lastDeductMs = b.lastDeductTime ? new Date(b.lastDeductTime).getTime() : now;
    const timeRemainingFromLastDeduct = lastDeductMs + (60 * 60 * 1000) - now;
    const remainingTokensTime = (tokens - 1) * 3600000;
    const expiryMs = now + Math.max(0, timeRemainingFromLastDeduct) + Math.max(0, remainingTokensTime);
    
    results.push({
      id: b.id,
      userID: b.userID,
      name: b.name || 'Loading...',
      ping: b.ping || 0,
      status: b.status,
      tokens: tokens,
      expiryTimestamp: expiryMs,
      totalEarned: b.totalEarned || 0,
      voucherCount: b.voucherCount || 0,
      lastVoucher: b.lastVoucher || null,
      phone: b.phone
    });
  }
  sendEncrypted(res, results);
});

app.get('/api/pricing', (req, res) => {
  sendEncrypted(res, {
    tokenPrice: TOKEN_PRICE,
    minAmount: MIN_AMOUNT,
    adminPhone: ADMIN_PHONE,
    rate: '1 บาท = 1 โทเค่น = 1 ชั่วโมง'
  });
});

app.post('/api/buy-key', async (req, res) => {
  const { voucherLink } = req.body;
  
  if (!voucherLink) {
    return sendEncrypted(res, { ok: false, error: 'MISSING_VOUCHER' });
  }

  const voucherCode = extractVoucherCode(voucherLink);
  if (!voucherCode) {
    return sendEncrypted(res, { ok: false, error: 'INVALID_VOUCHER_LINK' });
  }

  const redeemResult = await redeemVoucher(voucherCode, ADMIN_PHONE);
  
  if (!redeemResult.success) {
    return sendEncrypted(res, { ok: false, error: 'VOUCHER_REDEEM_FAILED' });
  }

  const amount = redeemResult.amount;
  
  if (amount < MIN_AMOUNT) {
    return sendEncrypted(res, { ok: false, error: 'MINIMUM_10_BAHT', received: amount });
  }

  const tokens = Math.floor(amount / TOKEN_PRICE);
  const keyResult = await createNewKeyInDB(tokens);
  
  if (!keyResult.success) {
    return sendEncrypted(res, { ok: false, error: 'KEY_CREATE_FAILED' });
  }

  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  savePurchase({
    ip,
    voucherCode,
    amount,
    tokens,
    key: keyResult.key,
    pathId: keyResult.pathId
  });

  sendEncrypted(res, {
    ok: true,
    key: keyResult.key,
    tokens: tokens,
    hours: tokens,
    amount: amount,
    message: 'ซื้อคีย์สำเร็จ! ใช้คีย์นี้เพื่อเริ่มใช้งานบอท'
  });
});

app.get('/api/purchase-history', (req, res) => {
  let history = [];
  if (fs.existsSync(purchaseHistoryFile)) {
    try {
      history = JSON.parse(fs.readFileSync(purchaseHistoryFile, 'utf8'));
    } catch (e) {}
  }
  sendEncrypted(res, history);
});

app.get('/api/ip-data', (req, res) => {
  let data = {};
  if (fs.existsSync(ipDataFile)) {
    try {
      data = JSON.parse(fs.readFileSync(ipDataFile, 'utf8'));
    } catch (e) {}
  }
  sendEncrypted(res, data);
});

const htmlPage = `<!DOCTYPE html>
<html lang="th">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
<title>AutoRedbag V.3.0 - Auto Topup</title>
<link href="https://fonts.googleapis.com/css2?family=Kanit:wght@300;400;500;600&display=swap" rel="stylesheet">
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css">

<style>
  :root {
    --bg-dark: #0f0f13;
    --card-bg: rgba(30, 30, 35, 0.7);
    --primary: #3b82f6;
    --success: #10b981;
    --danger: #ef4444;
    --warning: #f59e0b;
    --purple: #8b5cf6;
    --text-main: #ffffff;
    --text-sub: #9ca3af;
    --nav-height: 65px;
  }
  * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; outline: none; }
  html { height: 100%; overflow: hidden; }
  body {
    margin: 0; padding: 0; font-family: 'Kanit', sans-serif;
    background: var(--bg-dark); color: var(--text-main);
    overflow: hidden; height: 100dvh; min-height: 100dvh;
    display: flex; flex-direction: column;
  }
  .bg-orb { position: fixed; border-radius: 50%; filter: blur(90px); z-index: -1; opacity: 0.3; }
  .orb-1 { top: -10%; left: -10%; width: 250px; height: 250px; background: var(--primary); }
  .orb-2 { bottom: 10%; right: -10%; width: 200px; height: 200px; background: var(--purple); }
  .orb-3 { top: 40%; left: 50%; width: 180px; height: 180px; background: var(--success); opacity: 0.15; }
  header {
    padding: 15px 20px; padding-top: max(15px, env(safe-area-inset-top));
    display: flex; justify-content: space-between; align-items: center;
    background: rgba(15, 15, 19, 0.85); backdrop-filter: blur(10px); z-index: 10;
  }
  header h1 { margin: 0; font-size: 18px; font-weight: 600; }
  .main-viewport { 
    flex: 1; position: relative; overflow-y: auto; overflow-x: hidden;
    -webkit-overflow-scrolling: touch;
    padding-bottom: calc(var(--nav-height) + 30px); height: 100%;
  }
  .page { display: none; padding: 20px; padding-bottom: 100px; animation: fadeIn 0.3s ease; min-height: 100%; }
  .page.active { display: block; }
  @keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
  .glass-card {
    background: var(--card-bg); backdrop-filter: blur(15px);
    border: 1px solid rgba(255,255,255,0.06); border-radius: 20px;
    padding: 20px; margin-bottom: 15px; box-shadow: 0 10px 30px rgba(0,0,0,0.2);
  }
  .input-group { margin-bottom: 14px; position: relative; }
  .input-icon { position: absolute; left: 14px; top: 13px; color: var(--primary); font-size: 14px; opacity: 0.8; }
  input, textarea {
    width: 100%; background: rgba(0,0,0,0.25); border: 1px solid rgba(255,255,255,0.08);
    border-radius: 14px; padding: 12px 14px 12px 40px; color: white; font-family: 'Kanit', sans-serif; font-size: 13px;
  }
  input:focus, textarea:focus { border-color: var(--primary); background: rgba(0,0,0,0.4); }
  .btn-action {
    width: 100%; border: none; background: linear-gradient(135deg, var(--primary), #2563eb);
    color: white; padding: 14px; border-radius: 14px; font-family: 'Kanit', sans-serif;
    font-size: 14px; font-weight: 500; cursor: pointer; box-shadow: 0 5px 15px rgba(59, 130, 246, 0.25);
  }
  .btn-action:active { transform: scale(0.97); }
  .btn-success { background: linear-gradient(135deg, var(--success), #059669); box-shadow: 0 5px 15px rgba(16, 185, 129, 0.25); }
  .btn-purple { background: linear-gradient(135deg, var(--purple), #7c3aed); box-shadow: 0 5px 15px rgba(139, 92, 246, 0.25); }
  .card-title { margin-bottom: 12px; font-weight: 500; font-size: 14px; display: flex; align-items: center; gap: 8px; }
  .card-title i { color: var(--primary); font-size: 16px; }
  .price-box {
    background: linear-gradient(135deg, rgba(139, 92, 246, 0.2), rgba(139, 92, 246, 0.05));
    border: 1px solid rgba(139, 92, 246, 0.3); border-radius: 16px;
    padding: 20px; text-align: center; margin-bottom: 20px;
  }
  .price-title { font-size: 12px; color: var(--text-sub); margin-bottom: 8px; }
  .price-value { font-size: 32px; font-weight: 700; color: var(--purple); text-shadow: 0 0 20px rgba(139, 92, 246, 0.4); }
  .price-note { font-size: 11px; color: var(--text-sub); margin-top: 8px; }
  .key-display {
    background: rgba(16, 185, 129, 0.1); border: 2px dashed var(--success);
    border-radius: 14px; padding: 20px; text-align: center; margin: 15px 0;
  }
  .key-value { font-size: 20px; font-weight: 600; color: var(--success); font-family: monospace; letter-spacing: 2px; word-break: break-all; }
  .key-label { font-size: 11px; color: var(--text-sub); margin-bottom: 10px; }
  .stats-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; margin-bottom: 20px; }
  .stat-box { background: rgba(0,0,0,0.2); border-radius: 16px; padding: 16px; text-align: center; border: 1px solid rgba(255,255,255,0.05); }
  .stat-value { font-size: 24px; font-weight: 600; color: var(--success); text-shadow: 0 0 20px rgba(16, 185, 129, 0.3); }
  .stat-label { font-size: 11px; color: var(--text-sub); margin-top: 4px; }
  .bot-item { display: flex; flex-direction: column; gap: 12px; position: relative; overflow: hidden; padding: 18px; transition: all 0.3s ease; }
  .bot-head { display: flex; align-items: center; gap: 12px; }
  .avatar-wrapper { position: relative; width: 42px; height: 42px; display: flex; align-items: center; justify-content: center; }
  .bot-avatar {
    width: 100%; height: 100%; z-index: 2; background: linear-gradient(to bottom right, #333, #151515);
    border-radius: 50%; display: flex; align-items: center; justify-content: center;
    font-size: 18px; color: var(--text-sub); border: 1px solid rgba(255,255,255,0.1); transition: all 0.3s ease;
  }
  .bot-avatar i.fa-facebook-f { color: #ffffff; filter: drop-shadow(0 0 8px rgba(255,255,255,0.8)); animation: pulseWhite 2s ease-in-out infinite; }
  @keyframes pulseWhite { 0%, 100% { opacity: 1; filter: drop-shadow(0 0 8px rgba(255,255,255,1)); } 50% { opacity: 0.5; filter: drop-shadow(0 0 4px rgba(255,255,255,0.4)); } }
  .working-ring {
    position: absolute; top: -3px; left: -3px; right: -3px; bottom: -3px;
    border-radius: 50%; border: 2px solid transparent; border-top-color: var(--success); border-right-color: var(--success);
    z-index: 1; animation: spinRing 1.5s linear infinite; opacity: 0;
  }
  .bot-item.online .working-ring { opacity: 1; }
  @keyframes spinRing { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
  .bot-info h3 { margin: 0; font-size: 15px; font-weight: 500; transition: all 0.3s; }
  .bot-info p { margin: 2px 0 0; font-size: 11px; color: var(--text-sub); transition: color 0.3s; }
  .ping-badge { position: absolute; top: 18px; right: 18px; font-size: 10px; font-weight: 600; transition: color 0.3s; }
  .earnings-box {
    background: linear-gradient(135deg, rgba(16, 185, 129, 0.15), rgba(16, 185, 129, 0.05));
    border: 1px solid rgba(16, 185, 129, 0.2); border-radius: 12px;
    padding: 12px 16px; display: flex; align-items: center; justify-content: space-between;
  }
  .earnings-label { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--text-sub); }
  .earnings-value { font-size: 18px; font-weight: 600; color: var(--success); }
  .voucher-count { background: rgba(16, 185, 129, 0.2); color: var(--success); padding: 2px 8px; border-radius: 10px; font-size: 10px; font-weight: 500; }
  .last-voucher { background: rgba(0,0,0,0.2); border-radius: 10px; padding: 10px 14px; font-size: 11px; color: var(--text-sub); display: flex; align-items: center; gap: 8px; }
  .last-voucher i { color: var(--warning); }
  .timer-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; background: rgba(0,0,0,0.2); border-radius: 12px; padding: 8px; }
  #bot-list-container { padding-bottom: 20px; }
  .t-box { text-align: center; }
  .t-val { display: block; font-size: 16px; font-weight: 600; color: var(--primary); font-variant-numeric: tabular-nums; }
  .t-lbl { font-size: 8px; color: var(--text-sub); }
  .nav-bar {
    position: fixed; bottom: 0; left: 0; right: 0; height: var(--nav-height);
    background: rgba(15, 15, 19, 0.95); backdrop-filter: blur(20px);
    display: flex; justify-content: space-around; align-items: center;
    border-top: 1px solid rgba(255,255,255,0.05); padding-bottom: max(10px, env(safe-area-inset-bottom)); z-index: 100;
    box-sizing: content-box;
  }
  .nav-item { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; color: var(--text-sub); gap: 3px; height: 100%; transition: 0.2s; cursor: pointer; }
  .nav-item i { font-size: 18px; margin-bottom: 2px; }
  .nav-item span { font-size: 9px; font-weight: 500; }
  .nav-item.active { color: var(--primary); }
  .nav-item.active i { transform: translateY(-2px); color: var(--primary); }
  #loading-overlay {
    position: fixed; top: 0; left: 0; width: 100%; height: 100%;
    background: rgba(0,0,0,0.6); backdrop-filter: blur(8px); z-index: 9999;
    display: flex; flex-direction: column; justify-content: center; align-items: center;
    opacity: 0; pointer-events: none; transition: opacity 0.3s;
  }
  #loading-overlay.active { opacity: 1; pointer-events: all; }
  .spinner {
    width: 45px; height: 45px; border: 3px solid rgba(255,255,255,0.1);
    border-top: 3px solid var(--primary); border-radius: 50%;
    animation: spin 0.8s cubic-bezier(0.4, 0, 0.2, 1) infinite; margin-bottom: 15px;
  }
  @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
  #toast {
    position: fixed; top: -60px; left: 50%; transform: translateX(-50%);
    background: rgba(255,255,255,0.95); color: #111; padding: 10px 20px;
    border-radius: 30px; font-size: 13px; font-weight: 500;
    box-shadow: 0 10px 40px rgba(0,0,0,0.5); z-index: 2000;
    transition: 0.4s; display: flex; align-items: center; gap: 8px; white-space: nowrap;
  }
  #toast.show { top: 20px; }
  .copy-btn {
    background: rgba(16, 185, 129, 0.2); border: 1px solid var(--success);
    color: var(--success); padding: 8px 16px; border-radius: 8px;
    font-size: 12px; cursor: pointer; margin-top: 10px; transition: all 0.2s;
  }
  .copy-btn:hover { background: rgba(16, 185, 129, 0.3); }
</style>
</head>
<body>

<div class="bg-orb orb-1"></div>
<div class="bg-orb orb-2"></div>
<div class="bg-orb orb-3"></div>

<div id="loading-overlay"><div class="spinner"></div><div class="loading-text" style="font-size:14px;">กำลังประมวลผล...</div></div>
<div id="toast"><i class="fa-solid fa-circle-check"></i> <span>ข้อความแจ้งเตือน</span></div>

<header>
  <h1>AutoRedbag <span style="color:var(--primary); font-size:0.8em;">V.3.0</span></h1>
  <div style="font-size:9px; padding:3px 8px; background:rgba(16,185,129,0.15); color:var(--success); border-radius:12px;">Auto Topup</div>
</header>

<div class="main-viewport">
  <div id="page-buy" class="page">
    <div class="price-box">
      <div class="price-title"><i class="fa-solid fa-tag"></i> ราคา</div>
      <div class="price-value">1 บาท</div>
      <div class="price-note">= 1 โทเค่น = 1 ชั่วโมง<br>ขั้นต่ำ 10 บาท</div>
    </div>
    
    <div class="glass-card">
      <div class="card-title">
        <i class="fa-solid fa-gift" style="color:var(--purple)"></i>
        <span>ซื้อคีย์ด้วยซองอังเปา</span>
      </div>
      <div class="input-group">
        <i class="fa-solid fa-link input-icon" style="color:var(--purple)"></i>
        <input type="text" id="buy-voucher-link" placeholder="วางลิ้งซอง TrueWallet...">
      </div>
      <button class="btn-action btn-purple" onclick="buyKey()">
        <i class="fa-solid fa-key"></i> ซื้อคีย์
      </button>
    </div>
    
    <div id="key-result" style="display:none;">
      <div class="glass-card" style="border-color:var(--success);">
        <div class="card-title">
          <i class="fa-solid fa-check-circle" style="color:var(--success)"></i>
          <span>ซื้อสำเร็จ!</span>
        </div>
        <div class="key-display">
          <div class="key-label">คีย์ของคุณ (คัดลอกไว้ใช้งาน)</div>
          <div class="key-value" id="new-key"></div>
          <button class="copy-btn" onclick="copyKey()">
            <i class="fa-solid fa-copy"></i> คัดลอกคีย์
          </button>
        </div>
        <div style="text-align:center; margin-top:15px; font-size:12px; color:var(--text-sub);">
          ได้รับ <span id="key-tokens" style="color:var(--success); font-weight:600;"></span> โทเค่น 
          = <span id="key-hours" style="color:var(--success); font-weight:600;"></span> ชั่วโมง
        </div>
      </div>
    </div>
  </div>

  <div id="page-add" class="page active">
    <div id="step-key" class="glass-card">
      <div class="card-title">
        <i class="fa-solid fa-key"></i>
        <span>ยืนยันสิทธิ์ใช้งาน</span>
      </div>
      <div class="input-group">
        <i class="fa-solid fa-key input-icon"></i>
        <input type="text" id="input-key" placeholder="กรอก Key ของคุณ...">
      </div>
      <button class="btn-action" onclick="verifyKey()">ตรวจสอบคีย์</button>
    </div>
    <div id="step-config" class="glass-card" style="display:none;">
      <div class="card-title">
        <i class="fa-solid fa-robot"></i>
        <span>ตั้งค่าบอท</span>
      </div>
      <div class="input-group"><i class="fa-solid fa-wallet input-icon"></i><input type="tel" id="input-phone" placeholder="เบอร์ Wallet TrueMoney (10 หลัก)"></div>
      <div class="input-group"><i class="fa-solid fa-code input-icon"></i><textarea id="input-token" rows="3" placeholder="วาง AppState JSON..."></textarea></div>
      <button class="btn-action" onclick="submitBot()">เริ่มการทำงาน</button>
    </div>
  </div>

  <div id="page-dash" class="page">
    <div class="stats-grid">
      <div class="stat-box">
        <div class="stat-value" id="total-bots">0</div>
        <div class="stat-label">บอทที่ทำงาน</div>
      </div>
      <div class="stat-box">
        <div class="stat-value" id="total-earned" style="color: var(--warning);">0</div>
        <div class="stat-label">ยอดรวม (บาท)</div>
      </div>
    </div>
    <div style="margin-bottom:10px; font-size:12px; opacity:0.6; margin-left:5px;">บอทที่กำลังทำงาน</div>
    <div id="bot-list-container"></div>
  </div>
</div>

<nav class="nav-bar">
  <div class="nav-item" onclick="navTo('buy', this)"><i class="fa-solid fa-cart-shopping"></i><span>ซื้อคีย์</span></div>
  <div class="nav-item active" onclick="navTo('add', this)"><i class="fa-solid fa-square-plus"></i><span>เพิ่มบอท</span></div>
  <div class="nav-item" onclick="navTo('dash', this)"><i class="fa-solid fa-layer-group"></i><span>แดชบอร์ด</span></div>
</nav>

<script>
const ENC_KEY = 'AutoRedbagV3SecretKey2024!@#$%^&*()';
const CUSTOM_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const STANDARD_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function xorEncrypt(text, key) {
  let result = '';
  for (let i = 0; i < text.length; i++) {
    const keyChar = key.charCodeAt(i % key.length);
    const textChar = text.charCodeAt(i);
    result += String.fromCharCode(textChar ^ keyChar);
  }
  return result;
}

function customBase64Encode(str) {
  const base64 = btoa(str);
  return base64.split('').map(c => {
    const idx = STANDARD_ALPHABET.indexOf(c);
    return idx >= 0 ? CUSTOM_ALPHABET[idx] : c;
  }).join('');
}

function customBase64Decode(str) {
  const base64 = str.split('').map(c => {
    const idx = CUSTOM_ALPHABET.indexOf(c);
    return idx >= 0 ? STANDARD_ALPHABET[idx] : c;
  }).join('');
  try { return atob(base64); } catch (e) { return null; }
}

function encodeData(data) {
  try {
    const jsonStr = typeof data === 'string' ? data : JSON.stringify(data);
    const timestamp = Date.now().toString(36);
    const dataWithTime = timestamp + '|' + jsonStr;
    const encrypted = xorEncrypt(dataWithTime, ENC_KEY);
    const encoded = customBase64Encode(encrypted);
    const padding = Math.random().toString(36).substring(2, 6);
    return padding + encoded.split('').reverse().join('') + padding;
  } catch (e) { return null; }
}

function decodeData(encodedStr) {
  try {
    const padLen = 4;
    if (encodedStr.length < padLen * 2) return null;
    const cleanStr = encodedStr.substring(padLen, encodedStr.length - padLen);
    const reversed = cleanStr.split('').reverse().join('');
    const decoded = customBase64Decode(reversed);
    if (!decoded) return null;
    const decrypted = xorEncrypt(decoded, ENC_KEY);
    const parts = decrypted.split('|');
    if (parts.length < 2) return null;
    const timestamp = parseInt(parts[0], 36);
    const age = Date.now() - timestamp;
    if (age > 300000) return null;
    return parts.slice(1).join('|');
  } catch (e) { return null; }
}

async function apiGet(url) {
  const res = await fetch(url);
  const data = await res.json();
  if (data._enc) {
    const decoded = decodeData(data._enc);
    return decoded ? JSON.parse(decoded) : null;
  }
  return data;
}

async function apiPost(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ _enc: encodeData(body) })
  });
  const data = await res.json();
  if (data._enc) {
    const decoded = decodeData(data._enc);
    return decoded ? JSON.parse(decoded) : null;
  }
  return data;
}

let userKey = '';
let fetchTimer = null;
let countdownInterval = null;
let lastBotsData = [];
let currentKey = '';

function toggleLoading(show, text) {
  const o = document.getElementById('loading-overlay');
  o.querySelector('.loading-text').innerText = text || 'กำลังประมวลผล...';
  show ? o.classList.add('active') : o.classList.remove('active');
}

function showToast(msg, isError) {
  const t = document.getElementById('toast');
  const icon = isError ? 'fa-circle-xmark' : 'fa-circle-check';
  const color = isError ? '#ef4444' : '#10b981';
  t.innerHTML = '<i class="fa-solid ' + icon + '" style="color:' + color + '"></i> <span>' + msg + '</span>';
  t.classList.add('show'); 
  setTimeout(function() { t.classList.remove('show'); }, 3000);
}

function navTo(pageId, el) {
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  el.classList.add('active');
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById('page-' + pageId).classList.add('active');

  if(pageId === 'dash') {
    loadBots();
    if(!fetchTimer) fetchTimer = setInterval(loadBots, 5000);
    if(!countdownInterval) countdownInterval = setInterval(updateCountdowns, 1000);
  } else {
    if(fetchTimer) { clearInterval(fetchTimer); fetchTimer = null; }
    if(countdownInterval) { clearInterval(countdownInterval); countdownInterval = null; }
  }
}

function resetKeyForm() {
  userKey = '';
  const keyInput = document.getElementById('input-key');
  keyInput.value = '';
  keyInput.disabled = false;
  document.querySelector('#step-key button').style.display = 'block';
  document.getElementById('step-config').style.display = 'none';
  document.getElementById('input-phone').value = '';
  document.getElementById('input-token').value = '';
}

function updateCountdowns() {
  const now = Date.now();
  document.querySelectorAll('.bot-item').forEach(el => {
    const expiry = parseInt(el.dataset.expiry);
    if (!expiry || isNaN(expiry)) return;
    const diff = expiry - now;
    let d='0', h='00', m='00', s='00';
    if (diff > 0) {
      const days = Math.floor(diff / 86400000);
      const hours = Math.floor((diff % 86400000) / 3600000);
      const minutes = Math.floor((diff % 3600000) / 60000);
      const seconds = Math.floor((diff % 60000) / 1000);
      d = days.toString();
      h = hours.toString().padStart(2, '0');
      m = minutes.toString().padStart(2, '0');
      s = seconds.toString().padStart(2, '0');
    }
    const elD = el.querySelector('.v-d');
    const elH = el.querySelector('.v-h');
    const elM = el.querySelector('.v-m');
    const elS = el.querySelector('.v-s');
    if(elD) elD.innerText = d;
    if(elH) elH.innerText = h;
    if(elM) elM.innerText = m;
    if(elS) elS.innerText = s;
  });
}

async function buyKey() {
  const voucherLink = document.getElementById('buy-voucher-link').value.trim();
  if (!voucherLink) return showToast('กรุณาวางลิ้งซองอังเปา', true);
  
  toggleLoading(true, 'กำลังตรวจสอบซอง...');
  try {
    const data = await apiPost('/api/buy-key', { voucherLink: voucherLink });
    toggleLoading(false);
    
    if (data && data.ok) {
      currentKey = data.key;
      document.getElementById('new-key').textContent = data.key;
      document.getElementById('key-tokens').textContent = data.tokens;
      document.getElementById('key-hours').textContent = data.hours;
      document.getElementById('key-result').style.display = 'block';
      document.getElementById('buy-voucher-link').value = '';
      showToast('ซื้อคีย์สำเร็จ!');
    } else {
      const errorMsg = {
        'MISSING_VOUCHER': 'กรุณาใส่ลิ้งซอง',
        'INVALID_VOUCHER_LINK': 'ลิ้งซองไม่ถูกต้อง',
        'VOUCHER_REDEEM_FAILED': 'ไม่สามารถเติมเงินจากซองนี้ได้',
        'MINIMUM_10_BAHT': 'ขั้นต่ำ 10 บาท (ได้รับ ' + (data ? data.received : 0) + ' บาท)',
        'KEY_CREATE_FAILED': 'สร้างคีย์ไม่สำเร็จ ลองใหม่อีกครั้ง'
      }[data ? data.error : ''] || (data ? data.error : 'เกิดข้อผิดพลาด');
      showToast(errorMsg, true);
    }
  } catch (e) {
    toggleLoading(false);
    showToast('Network Error', true);
  }
}

function copyKey() {
  if (!currentKey) return;
  navigator.clipboard.writeText(currentKey).then(function() {
    showToast('คัดลอกคีย์แล้ว!');
  }).catch(function() {
    const textarea = document.createElement('textarea');
    textarea.value = currentKey;
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    document.body.removeChild(textarea);
    showToast('คัดลอกคีย์แล้ว!');
  });
}

async function verifyKey() {
  const key = document.getElementById('input-key').value.trim();
  if(!key) return showToast('กรุณากรอกคีย์', true);
  toggleLoading(true);
  try {
    const data = await apiGet('/api/check-key?key=' + encodeURIComponent(key));
    toggleLoading(false);
    if(data && data.ok) {
      userKey = key; 
      showToast('ยืนยันตัวตนสำเร็จ! (เหลือ ' + data.tokens_remaining + ' เครดิต)');
      document.getElementById('input-key').disabled = true;
      document.querySelector('#step-key button').style.display = 'none';
      document.getElementById('step-config').style.display = 'block';
    } else { 
      showToast(data ? data.error : 'คีย์ไม่ถูกต้อง', true); 
    }
  } catch(e) { 
    toggleLoading(false); 
    showToast('Server Error', true); 
  }
}

async function submitBot() {
  const phone = document.getElementById('input-phone').value.trim();
  const token = document.getElementById('input-token').value.trim();
  if(!phone || !token) return showToast('กรอกข้อมูลให้ครบ', true);
  if(phone.length !== 10) return showToast('เบอร์ต้องมี 10 หลัก', true);
  if(!userKey) return showToast('กรุณายืนยันคีย์ก่อน', true);
  
  toggleLoading(true, 'กำลังเชื่อมต่อบอท...');
  try {
    const data = await apiPost('/api/add-bot', { key: userKey, phone: phone, token: token });
    toggleLoading(false);
    
    if(data && data.ok) {
      showToast('เชื่อมต่อบอทสำเร็จ!');
      resetKeyForm();
      setTimeout(function() { 
        navTo('dash', document.querySelectorAll('.nav-item')[2]); 
      }, 800);
    } else { 
      showToast(data ? data.error : 'เกิดข้อผิดพลาด', true); 
    }
  } catch(e) { 
    toggleLoading(false); 
    showToast('Network Error', true); 
  }
}

async function loadBots() {
  try {
    const bots = await apiGet('/api/bots');
    if (bots) {
      lastBotsData = bots;
      renderBotList(bots);
      updateStats(bots);
    }
  } catch(e) {
    console.error('Load bots error:', e);
  }
}

function updateStats(bots) {
  const totalBots = bots.filter(function(b) { return b.status === 'online'; }).length;
  const totalEarned = bots.reduce(function(sum, b) { return sum + (b.totalEarned || 0); }, 0);
  document.getElementById('total-bots').textContent = totalBots;
  document.getElementById('total-earned').textContent = totalEarned.toFixed(2);
}

function renderBotList(bots) {
  const container = document.getElementById('bot-list-container');
  if(bots.length === 0) {
    container.innerHTML = '<div style="text-align:center;padding:60px 20px;opacity:0.5;font-size:13px;"><i class="fa-solid fa-robot" style="font-size:30px;margin-bottom:10px;"></i><br>ยังไม่มีบอททำงาน</div>';
    return;
  }
  const existingItems = container.querySelectorAll('.bot-item');
  if(existingItems.length !== bots.length) {
    container.innerHTML = bots.map(function(b) { return createBotHTML(b); }).join('');
    updateCountdowns();
    return;
  }
  bots.forEach(function(b) {
    const el = container.querySelector('.bot-item[data-id="' + b.id + '"]');
    if(!el) return;
    const nameEl = el.querySelector('.bot-info h3');
    if(nameEl) nameEl.textContent = b.name || 'Loading...';
    const statusEl = el.querySelector('.bot-info p');
    if(statusEl) {
      statusEl.textContent = '● ' + b.status.toUpperCase();
      statusEl.style.color = b.status === 'online' ? 'var(--success)' : 'var(--danger)';
    }
    const pingBadge = el.querySelector('.ping-badge');
    if(pingBadge) pingBadge.innerHTML = '<i class="fa-solid fa-wifi"></i> ' + b.ping + 'ms';
    const earningsValue = el.querySelector('.earnings-value');
    if(earningsValue) earningsValue.textContent = (b.totalEarned || 0).toFixed(2) + ' ฿';
    const voucherCount = el.querySelector('.voucher-count');
    if(voucherCount) voucherCount.textContent = (b.voucherCount || 0) + ' ซอง';
    if(el.dataset.expiry != b.expiryTimestamp) el.dataset.expiry = b.expiryTimestamp;
  });
}

function createBotHTML(b) {
  const isOnline = b.status === 'online';
  const statusColor = isOnline ? 'var(--success)' : 'var(--danger)';
  const displayName = b.name || 'Loading...';
  const totalEarned = (b.totalEarned || 0).toFixed(2);
  const voucherCount = b.voucherCount || 0;
  const lastVoucherText = b.lastVoucher 
    ? 'ล่าสุด: +' + b.lastVoucher.amount + '฿ (' + new Date(b.lastVoucher.time).toLocaleTimeString('th-TH', {hour: '2-digit', minute:'2-digit'}) + ')'
    : 'ยังไม่มีซองที่ดักได้';
  
  return '<div class="glass-card bot-item ' + (isOnline ? 'online' : '') + '" data-expiry="' + b.expiryTimestamp + '" data-id="' + b.id + '">' +
    '<div class="ping-badge" style="color:' + (b.ping < 200 ? 'var(--success)' : '#fbbf24') + '">' +
      '<i class="fa-solid fa-wifi"></i> ' + b.ping + 'ms' +
    '</div>' +
    '<div class="bot-head">' +
      '<div class="avatar-wrapper">' +
        '<div class="working-ring"></div>' +
        '<div class="bot-avatar"><i class="fa-brands fa-facebook-f"></i></div>' +
      '</div>' +
      '<div class="bot-info">' +
        '<h3>' + displayName + '</h3>' +
        '<p style="color:' + statusColor + '">● ' + b.status.toUpperCase() + '</p>' +
      '</div>' +
    '</div>' +
    '<div class="earnings-box">' +
      '<div class="earnings-label">' +
        '<i class="fa-solid fa-coins"></i>' +
        '<span>ยอดที่ดักได้</span>' +
        '<span class="voucher-count">' + voucherCount + ' ซอง</span>' +
      '</div>' +
      '<div class="earnings-value">' + totalEarned + ' ฿</div>' +
    '</div>' +
    '<div class="last-voucher">' +
      '<i class="fa-solid fa-gift"></i>' +
      '<span class="last-voucher-text">' + lastVoucherText + '</span>' +
    '</div>' +
    '<div class="timer-grid">' +
      '<div class="t-box"><span class="t-val v-d">0</span><span class="t-lbl">วัน</span></div>' +
      '<div class="t-box"><span class="t-val v-h">00</span><span class="t-lbl">ชม.</span></div>' +
      '<div class="t-box"><span class="t-val v-m">00</span><span class="t-lbl">นาที</span></div>' +
      '<div class="t-box"><span class="t-val v-s">00</span><span class="t-lbl">วิ</span></div>' +
    '</div>' +
    '<div style="font-size:11px; color:var(--text-sub); display:flex; justify-content:space-between; margin-top:5px;">' +
      '<span class="token-display"><i class="fa-solid fa-coins"></i> คงเหลือ: ' + b.tokens + '</span>' +
      '<span class="uid-display" style="font-family: monospace; opacity: 0.7; font-size: 10px;">' + (b.userID || '') + '</span>' +
    '</div>' +
  '</div>';
}

document.addEventListener('DOMContentLoaded', function() {
  if(document.getElementById('page-dash').classList.contains('active')) {
    loadBots();
    if(!fetchTimer) fetchTimer = setInterval(loadBots, 5000);
    if(!countdownInterval) countdownInterval = setInterval(updateCountdowns, 1000);
  }
});
</script>
</body>
</html>`;

app.get('/', (req, res) => res.send(htmlPage));

app.listen(PORT, () => {
  console.log('🚀 Server running on http://localhost:' + PORT);
  console.log('🔐 Encryption: ENABLED');
  console.log('💰 Key Shop: ENABLED');
  startExistingBots();
});
