let ws = null;
let reconnectTimer = null;
let isConnected = false;

const WS_URL = 'ws://127.0.0.1:9999';

function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

  console.log(`[BG] Attempting to connect to ${WS_URL}...`);
  ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    console.log('[BG] Connected to server successfully');
    isConnected = true;
    updateBadge(true);
  };

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      handleServerMessage(msg);
    } catch (err) {
      console.error('[BG] Message parse error:', err);
    }
  };

  ws.onclose = (event) => {
    console.log(`[BG] Disconnected (code: ${event.code}, reason: ${event.reason})`);
    isConnected = false;
    updateBadge(false);
    scheduleReconnect();
  };

  ws.onerror = (err) => {
    console.error('[BG] WebSocket Error:', err);
  };
}

function scheduleReconnect() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connect, 3000);
}

function updateBadge(connected) {
  chrome.action.setBadgeText({ text: connected ? 'ON' : 'OFF' });
  chrome.action.setBadgeBackgroundColor({ color: connected ? '#0a0' : '#a00' });
}

async function handleServerMessage(msg) {
  const { id, command, params } = msg;

  try {
    // Try to find the best tab to talk to
    let tabs = await chrome.tabs.query({ url: '*://*.higgsfield.ai/*', active: true });
    if (tabs.length === 0) {
      tabs = await chrome.tabs.query({ url: '*://*.higgsfield.ai/*' });
    }

    if (tabs.length === 0) {
      sendToServer({ id, success: false, error: 'No higgsfield.ai tab open' });
      return;
    }

    // Try sending to tabs one by one until one works
    let lastError = null;
    for (const tab of tabs) {
      try {
        const result = await sendToTab(tab.id, msg);
        sendToServer({ id, success: true, data: result });
        return;
      } catch (err) {
        lastError = err;
        console.warn(`[BG] Failed to send to tab ${tab.id}:`, err.message);
      }
    }

    sendToServer({ id, success: false, error: lastError?.message || 'Could not communicate with any tab' });
  } catch (err) {
    sendToServer({ id, success: false, error: err.message });
  }
}

function sendToServer(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function sendToTab(tabId, msg, retries = 3, delay = 500) {
  return new Promise((resolve, reject) => {
    function attempt(n) {
      chrome.tabs.sendMessage(tabId, msg, (response) => {
        if (chrome.runtime.lastError) {
          const errMsg = chrome.runtime.lastError.message;
          if (n < retries && (errMsg.includes('Receiving end does not exist') || errMsg.includes('Could not establish connection'))) {
            setTimeout(() => attempt(n + 1), delay);
          } else {
            reject(new Error(errMsg));
          }
        } else {
          resolve(response);
        }
      });
    }
    attempt(0);
  });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'ready') {
    console.log('[BG] Content script ready in tab', sender.tab?.id);
    sendToServer({ type: 'ready', tabId: sender.tab?.id });
    return;
  }
  if (msg && msg.type === 'startRequest') {
    console.log('[BG] User clicked Start in tab', sender.tab?.id);
    sendToServer({ type: 'userStart', tabId: sender.tab?.id });
    return;
  }
  if (msg && msg.type === 'getStatus') {
    sendResponse({ connected: isConnected });
  }
});

connect();
