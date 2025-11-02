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
    // bytes can be Uint8Array or Array<number>
    const arr = Array.from(bytes);
    const hex = arr.map(b => b.toString(16).padStart(2, '0')).join(' ');
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

/**
 * Compute simple 16-bit checksum as sum of bytes modulo 65536.
 * Accepts Array<number> or Uint8Array.
 */
function computeChecksum(bytes) {
    const arr = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
    let sum = 0;
    for (let i = 0; i < arr.length; ++i) {
        sum = (sum + arr[i]) & 0xFFFF;
    }
    return sum;
}

// NEW: message-oriented read loop
// Message format: 0xFF, <len:1>, <payload: len bytes>
// payload layout: payload[0] == 0x01, payload[1..] = data, last two bytes of payload are checksum (high, low)
// Only append a message to console if payload[0] === 0x01 and checksum matches
async function readLoop() {
    const buffer = []; // accumulate incoming bytes (numbers 0-255)
    try {
        while (keepReading && reader) {
            const { value, done } = await reader.read();
            if (done) break;
            if (value && value.length) {
                // append incoming bytes to buffer
                for (const b of value) buffer.push(b);

                // parse messages while possible
                while (true) {
                    // find start byte 0xFF
                    const startIdx = buffer.indexOf(0xFF);
                    if (startIdx === -1) {
                        // no start byte, discard old data to avoid unbounded growth
                        if (buffer.length > 1024) buffer.splice(0, buffer.length - 512);
                        break;
                    }

                    // ensure we have at least start + length byte
                    if (buffer.length < startIdx + 2) break;

                    const len = buffer[startIdx + 1]; // length byte
                    const totalNeeded = startIdx + 2 + len;
                    if (buffer.length < totalNeeded) break; // wait for full message

                    // extract payload (len bytes)
                    const dataPart = buffer.slice(startIdx + 2, startIdx + 2 + len - 2); // includes command, payload, checksum

                    // payload must be at least 3 bytes: command and checksum(2 bytes)
                    if (len >= 3 && buffer[startIdx + 2] === 0x01) {
                        const payload = buffer.slice(startIdx + 3, startIdx + 3 + len - 2);
                        // Split data (without checksum) and checksum bytes
                        const chkHigh = buffer[startIdx + 2 + len - 2];
                        const chkLow = buffer[startIdx + 2 + len - 1];
                        const expected = (chkHigh << 8) | chkLow;
                        const actual = computeChecksum(dataPart);
                        //console.log('Checksum actual=', actual, 'expected=', expected);
                        //appendHex(buffer.slice(startIdx, totalNeeded));
                        if (actual === expected) {
                            // parseMessage expects payload-like buffer starting at index 0 (marker at [0])
                            const status = parseMessage(payload, 0);
                            if (status) {
                                appendTextLine(JSON.stringify(status));
                                // also show raw message hex if desired:
                            } else {
                                appendTextLine('parseMessage: invalid/too short');
                            }
                        } else {
                            const actualHex = '0x' + actual.toString(16).padStart(4, '0').toUpperCase();
                            const expectedHex = '0x' + expected.toString(16).padStart(4, '0').toUpperCase();
                            appendTextLine(`Checksum actual= ${actualHex}, expected= ${expectedHex}`);
                            // show offending message in hex for diagnostics
                            //appendHex(buffer.slice(startIdx, totalNeeded));
                        }
                    } // else ignore this message

                    // remove consumed bytes up to end of this message
                    buffer.splice(0, totalNeeded);
                    // continue parsing any further messages in buffer
                } // end inner parse loop
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

        // 5) start continuous read loop (message-oriented)
        keepReading = true;
        reader = port.readable.getReader();
        setStatus('running - streaming hex messages');
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


/**
 * Parse a status message payload.
 * Expects payload[0] === 0x01, then struct starts at payload[1].
 * Returns an object matching the C++ struct or null on error/too short.
 */

function parseMessage(buf, startOffset = 0, littleEndian = true) {
    const p = buf instanceof Uint8Array ? buf : Uint8Array.from(buf);
    const STRUCT_SIZE = 40; // adjust if your C++ sizeof(status_payload) differs
    if (p.length < startOffset + STRUCT_SIZE) return null;

    const dv = new DataView(p.buffer, p.byteOffset + startOffset, STRUCT_SIZE);
    let off = 0;

    const id = dv.getUint16(off, littleEndian); off += 2;
    const sync_id = dv.getUint16(off, littleEndian); off += 2;
    const time_offset_ms = dv.getInt16(off, littleEndian); off += 2;

    // skip 2 bytes padding to align the next double to 8 bytes
    off += 2;

    const latitude = dv.getFloat64(off, littleEndian); off += 8;
    const longitude = dv.getFloat64(off, littleEndian); off += 8;
    const heading = dv.getFloat32(off, littleEndian); off += 4;
    const cov_pos = dv.getFloat32(off, littleEndian); off += 4;
    const speed_x = dv.getInt16(off, littleEndian); off += 2;
    const speed_y = dv.getInt16(off, littleEndian); off += 2;
    const rot_speed = dv.getInt16(off, littleEndian); off += 2;
    const drive_mode = dv.getUint8(off); off += 1;
    const aux_data_status = dv.getUint8(off); off += 1;

    return {
        id,
        sync_id,
        time_offset_ms,
        latitude,
        longitude,
        heading,
        cov_pos,
        speed_x,
        speed_y,
        rot_speed,
        drive_mode,
        aux_data_status
    };
}