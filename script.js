// Web Serial-based hex viewer with CONFIG then RUN handshake
let port = null;
let reader = null;
let writer = null;
let keepReading = false;

const CONFIG_STR = "#CONFIG,0,2402.5,5,0,LORA,5,1600,5,16\n";
const RUN_STR = "#RUN\n";

const connectBtn = document.getElementById('connect');
const disconnectBtn = document.getElementById('disconnect');
const statusEl = document.getElementById('status');
const logEl = document.getElementById('log');
const deviceNameEl = document.getElementById('deviceName');
const baudInput = document.getElementById('baud');

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();
let textBuffer = '';
let runSent = false;

function setStatus(s) { if (statusEl) statusEl.textContent = 'status: ' + s; }

function appendHex(bytes) {
    const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join(' ');
    const line = document.createElement('div');
    line.textContent = hex;
    logEl.appendChild(line);
    while (logEl.children.length > 2000) logEl.removeChild(logEl.firstChild);
    logEl.scrollTop = logEl.scrollHeight;
}

function appendTextLine(text) {
    const line = document.createElement('div');
    line.textContent = text;
    line.style.color = '#9ad';
    logEl.appendChild(line);
    while (logEl.children.length > 2000) logEl.removeChild(logEl.firstChild);
    logEl.scrollTop = logEl.scrollHeight;
}

async function writeString(s) {
    if (!writer) return;
    try {
        console.log("Sending:", s);
        await writer.write(textEncoder.encode(s));
    } catch (e) {
        console.warn('write error', e);
        setStatus('write error: ' + (e.message || e));
    }
}

// read from the port until the supplied substring is observed (returns accumulated text)
// releases the temporary reader lock before returning
async function readUntil(substring, timeoutMs = 5000) {
    const r = port.readable.getReader();
    let acc = '';
    const deadline = timeoutMs ? (Date.now() + timeoutMs) : Infinity;
    try {
        while (Date.now() < deadline) {
            const { value, done } = await r.read();
            if (done) break;
            if (value && value.length) {
                appendHex(value); // show raw bytes during handshake too
                const chunk = textDecoder.decode(value, { stream: true });
                acc += chunk;
                if (acc.includes(substring)) {
                    return acc;
                }
                // keep the accumulator bounded
                if (acc.length > 20000) acc = acc.slice(-4000);
            }
        }
        throw new Error('readUntil timeout or stream closed');
    } finally {
        try { r.releaseLock(); } catch (e) { /* ignore */ }
    }
}

async function readLoop() {
    try {
        while (keepReading && reader) {
            const { value, done } = await reader.read();
            if (done) break;
            if (value && value.length) {
                // always print hex
                appendHex(value);
            }
        }
    } catch (err) {
        console.error('Read error', err);
        setStatus('read error: ' + (err.message || err));
    } finally {
        try { reader && reader.releaseLock(); } catch (e) { }
    }
}

async function connect() {
    if (!('serial' in navigator)) {
        setStatus('Web Serial not supported. Enable experimental features or use Chromium');
        return;
    }
    try {
        console.log("Connecting...");
        const baudRate = Number(baudInput.value) || 921600;

        // user selects port
        port = await navigator.serial.requestPort();
        await port.open({ baudRate });

        deviceNameEl.textContent = 'connected';
        setStatus(`open @ ${baudRate}`);
        connectBtn.disabled = true;
        disconnectBtn.disabled = false;

        // Read serial port and check if "#NOT_INITIALIZED" string is on the data read. If so, print on console not initialized, if not print initialized
        textBuffer = '';
        let initialized = true;

        // temporary reader to check initialization
        const tempReader = port.readable.getReader();
        try {
            const initDeadline = Date.now() + 1000; // 1 second to detect
            while (Date.now() < initDeadline) {
                const { value, done } = await tempReader.read();
                if (done) break;
                if (value && value.length) {
                    const chunk = textDecoder.decode(value, { stream: true });
                    textBuffer += chunk;
                    if (textBuffer.includes('#NOT_INITIALIZED')) {
                        initialized = false;
                        break;
                    }
                    // keep buffer bounded
                    if (textBuffer.length > 1000) textBuffer = textBuffer.slice(-500);
                }
            }
        }
        catch (e) {
            console.warn('init read error', e);
        } finally {
            try { tempReader.releaseLock(); } catch (e) { /* ignore */ }
        }

        if (!initialized) {
            appendTextLine('Device NOT INITIALIZED');
            // prepare writer
            if (port.writable) {
                writer = port.writable.getWriter();
                // 1) send CONFIG
                await writeString(CONFIG_STR);
                appendTextLine("Sent " + CONFIG_STR.trim());

                // 2) wait for "#OK"
                try {
                    setStatus('waiting for first OK...');
                    await readUntil('#OK', 200);
                    appendTextLine('OK response');
                } catch (e) {
                    appendTextLine('OK not received: ' + e.message);
                    // cleanup and abort
                    try { await disconnect(); } catch (_) { }
                    return;
                }

                // 3) send RUN
                await writeString(RUN_STR);
                appendTextLine("Sent RUN");

                // 4) wait for "#OK"
                try {
                    setStatus('OK received');
                    await readUntil('#OK', 200);
                    appendTextLine('OK response');
                } catch (e) {
                    appendTextLine('OK not received: ' + e.message);
                    try { await disconnect(); } catch (_) { }
                    return;
                }
            } else {
                setStatus('port not writable');
            }

        } else {
            appendTextLine('Device initialized');
        }

        // 5) start continuous read loop (hex output)
        keepReading = true;
        reader = port.readable.getReader();
        setStatus('running - streaming hex');
        readLoop();
    } catch (err) {
        console.error(err);
        setStatus('open error: ' + (err.message || err));
        try { await disconnect(); } catch (_) { }
    }
}

async function disconnect() {
    keepReading = false;
    try {
        if (reader) {
            await reader.cancel();
            await reader.releaseLock();
            reader = null;
        }
        if (writer) {
            try { await writer.close(); } catch (e) { /* ignore */ }
            try { writer.releaseLock(); } catch (e) { /* ignore */ }
            writer = null;
        }
        if (port) {
            await port.close();
            port = null;
        }
        setStatus('closed');
    } catch (err) {
        console.warn('disconnect error', err);
        setStatus('close error: ' + (err.message || err));
    } finally {
        connectBtn.disabled = false;
        disconnectBtn.disabled = true;
        deviceNameEl.textContent = '/dev/ttyUSB0 (user pick)';
    }
}

connectBtn.addEventListener('click', connect);
disconnectBtn.addEventListener('click', disconnect);

// show available granted ports
(async () => {
    if (!('serial' in navigator)) return;
    try {
        const ports = await navigator.serial.getPorts();
        if (ports.length > 0) deviceNameEl.textContent = 'port available (click Connect)';
    } catch (e) { /* ignore */ }
})();