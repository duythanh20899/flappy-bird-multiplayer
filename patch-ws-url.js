#!/usr/bin/env node
/**
 * patch-ws-url.js
 * Run this after getting your Render.com URL to patch index.html.
 *
 * Usage:
 *   node patch-ws-url.js wss://your-server.onrender.com
 */
const fs = require('fs');
const path = require('path');

const wsUrl = process.argv[2];
if (!wsUrl || !wsUrl.startsWith('wss://')) {
  console.error('Usage: node patch-ws-url.js wss://your-server.onrender.com');
  process.exit(1);
}

const filePath = path.join(__dirname, 'index.html');
let html = fs.readFileSync(filePath, 'utf8');

// Replace placeholder or existing URL in meta tag
html = html.replace(
  /(<meta name="flappy-ws-url" content=")[^"]*(")/,
  '$1' + wsUrl + '$2'
);

fs.writeFileSync(filePath, html, 'utf8');
console.log('✅ Patched index.html with WebSocket URL: ' + wsUrl);
console.log('   Now commit and push to trigger Netlify redeploy.');
