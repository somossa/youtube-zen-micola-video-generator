chrome.runtime.sendMessage({ type: 'ready' });

function injectStartButton() {
  if (document.getElementById('gemini-start-btn')) return;

  const btn = document.createElement('button');
  btn.id = 'gemini-start-btn';
  btn.textContent = '▶ Start Automation';
  Object.assign(btn.style, {
    position: 'fixed',
    bottom: '20px',
    right: '20px',
    zIndex: '999999',
    padding: '12px 20px',
    backgroundColor: '#007bff',
    color: 'white',
    border: 'none',
    borderRadius: '8px',
    cursor: 'pointer',
    fontSize: '14px',
    fontWeight: 'bold',
    boxShadow: '0 4px 12px rgba(0,0,0,0.2)',
    transition: 'transform 0.2s, background-color 0.2s'
  });

  btn.onmouseover = () => btn.style.backgroundColor = '#0056b3';
  btn.onmouseout = () => btn.style.backgroundColor = '#007bff';
  btn.onmousedown = () => btn.style.transform = 'scale(0.95)';
  btn.onmouseup = () => btn.style.transform = 'scale(1)';

  btn.onclick = () => {
    btn.disabled = true;
    btn.textContent = '⌛ Automation Running...';
    btn.style.backgroundColor = '#28a745';
    chrome.runtime.sendMessage({ type: 'startRequest' });
  };

  document.body.appendChild(btn);
}

// Re-inject on navigation or if removed
setInterval(injectStartButton, 2000);
injectStartButton();

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleCommand(msg)
    .then((result) => sendResponse(result))
    .catch((err) => sendResponse({ error: err.message }));
  return true;
});

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function randomDelay(min, max) {
  return Math.floor(Math.random() * (max - min + 1) + min);
}

function setNativeValue(el, value) {
  const proto = Object.getPrototypeOf(el);
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) {
    setter.call(el, value);
  } else {
    el.value = value;
  }
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

async function handleCommand(msg) {
  const { command, params } = msg;

  switch (command) {
    case 'wait': {
      await sleep(params.ms);
      return null;
    }

    case 'click': {
      const el = document.querySelector(params.selector);
      if (!el) {
        console.error(`[CS] Click failed: Element not found: ${params.selector}`);
        throw new Error(`Element not found: ${params.selector}`);
      }
      console.log(`[CS] Clicking element: ${params.selector}`);
      el.click();
      return null;
    }

    case 'clickIf': {
      const el = document.querySelector(params.selector);
      if (!el) throw new Error(`Element not found: ${params.selector}`);
      if (el.getAttribute(params.attribute) !== params.value) {
        el.click();
      }
      return null;
    }

    case 'select': {
      const el = document.querySelector(params.selector);
      if (!el) throw new Error(`Select not found: ${params.selector}`);
      el.value = params.value;
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return null;
    }

    case 'setPrompt': {
      const container = document.querySelector('#image-form > fieldset > div > div.flex.gap-3');
      if (!container) throw new Error('Prompt container not found');
      
      container.click();
      await sleep(randomDelay(300, 500));

      const input = container.querySelector('[contenteditable="true"]') || 
                    container.querySelector('textarea') || 
                    container.querySelector('input');
      
      if (!input) throw new Error('Prompt input not found');
      
      input.focus();
      await sleep(randomDelay(200, 400));

      if (input.isContentEditable) {
        // SELECT ALL first
        document.execCommand('selectAll', false, null);
        await sleep(100);
        
        // Use insertText to REPLACE the selection with the new prompt
        // This is the most reliable way to clear and set in one go
        document.execCommand('insertText', false, params.text);
        
        // Trigger events to be safe
        input.dispatchEvent(new Event('input', { bubbles: true }));
      } else {
        // For standard inputs/textareas
        setNativeValue(input, '');
        await sleep(100);
        for (const char of params.text) {
          setNativeValue(input, input.value + char);
          await sleep(randomDelay(10, 30));
        }
      }
      
      return null;
    }

    case 'clearAttachments': {
      const container = document.querySelector("div[data-tour-anchor='tour-image-form-top-row']");
      if (container) {
        const buttons = container.querySelectorAll(
          "button.border.max-w-full.inline-grid.grid-flow-col.text-ellipsis.overflow-hidden.whitespace-nowrap.justify-center.items-center.content-center.font-medium"
        );
        buttons.forEach((cb) => cb.click());
      }
      return null;
    }

    case 'uploadFiles': {
      const fileInput = document.querySelector('input[type="file"]');
      if (!fileInput) throw new Error('File input not found');

      const dt = new DataTransfer();

      for (const file of params.files) {
        const binary = atob(file.data);
        const ab = new ArrayBuffer(binary.length);
        const ia = new Uint8Array(ab);
        for (let i = 0; i < binary.length; i++) {
          ia[i] = binary.charCodeAt(i);
        }
        const blob = new Blob([ab], { type: 'image/png' });
        dt.items.add(new File([blob], file.name, { type: 'image/png' }));
      }

      const nativeSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'files'
      ).set;
      nativeSetter.call(fileInput, dt.files);
      fileInput.dispatchEvent(new Event('change', { bubbles: true }));
      return null;
    }

    case 'waitForUploads': {
      const start = Date.now();
      const timeout = 60000; // 60s timeout
      while (Date.now() - start < timeout) {
        const images = document.querySelectorAll(
          "div[data-tour-anchor='tour-image-form-top-row'] img"
        );
        if (images.length >= params.count) return null;
        await sleep(1000);
      }
      throw new Error(`Timeout waiting for ${params.count} uploads`);
    }

    case 'getAssetId': {
      // Look for all asset IDs on the page
      const elements = document.querySelectorAll("[data-asset-id]");
      if (elements.length === 0) return null;
      
      // Usually the newest one is either the first or last depending on layout.
      // We'll take the first one found in the grid container if possible.
      const gridItem = document.querySelector("div[data-requested-cols-count] [data-asset-id]");
      if (gridItem) return gridItem.getAttribute('data-asset-id');

      // Fallback: just take the first one found anywhere
      return elements[0].getAttribute('data-asset-id');
    }

    case 'checkCaptcha': {
      const text = document.body.innerText.toLowerCase();
      const hasText =
        text.includes('verify you are human') ||
        text.includes('cloudflare') ||
        text.includes('hcaptcha') ||
        text.includes('captcha') ||
        text.includes('unusual activity');

      const hasElements = !!document.querySelector(
        'iframe[src*="captcha"], #challenge-form, .g-recaptcha, #cf-challenge, #hcaptcha-container'
      );

      return hasText || hasElements;
    }

    default:
      throw new Error(`Unknown command: ${command}`);
  }
}
