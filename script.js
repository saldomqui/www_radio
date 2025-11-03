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
const deviceNameEl = document.getElementById('deviceName');
const baudInput = document.getElementById('baud');

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();
let textBuffer = '';
let runSent = false;

function setStatus(s) { if (statusEl) statusEl.textContent = 'status: ' + s; }


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
      if (!value || !value.length) continue;

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

        // extract full payload (len bytes)
        const payloadFull = buffer.slice(startIdx + 2, startIdx + 2 + len);

        // payload must be at least 3 bytes: marker + checksum(2)
        if (payloadFull.length >= 3 && payloadFull[0] === 0x01) {
          // data to checksum = payloadFull[0 .. len-3] (i.e. excluding last two checksum bytes)
          const dataPart = payloadFull.slice(0, payloadFull.length - 2);
          const chkHigh = payloadFull[payloadFull.length - 2];
          const chkLow = payloadFull[payloadFull.length - 1];
          const expected = (chkHigh << 8) | chkLow;
          const actual = computeChecksum(dataPart);

          if (actual === expected) {
            // dataPart[0] == 0x01 (marker). The C struct bytes start at dataPart[1].
            // pass only the struct bytes to parseMessage
            const structBytes = Uint8Array.from(dataPart.slice(1));
            const status = parseMessage(structBytes, 0);
            if (status) {
              updateStatusArray(status);
              console.log('Updated status id=' + status.id, status);
            } else {
              console.warn('parseMessage failed for id=', dataPart[1]);
            }
          } else {
            const actualHex = '0x' + actual.toString(16).padStart(4, '0').toUpperCase();
            const expectedHex = '0x' + expected.toString(16).padStart(4, '0').toUpperCase();
            console.warn(`Checksum mismatch for message id=${payloadFull[1]}: actual=${actualHex} expected=${expectedHex}`);
          }
        } // end payload valid check

        // remove consumed bytes up to end of this message
        buffer.splice(0, totalNeeded);
        // continue parsing any further messages in buffer
      } // end inner parse loop
    }
  } catch (err) {
    console.error('Read error', err);
    setStatus('read error: ' + (err.message || err));
  } finally {
    try { reader && reader.releaseLock(); } catch (e) { /* ignore */ }
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
            // prepare writer
            if (port.writable) {
                writer = port.writable.getWriter();
                // 1) send CONFIG
                await writeString(CONFIG_STR);

                // 2) wait for "#OK"
                try {
                    setStatus('waiting for first OK...');
                    await readUntil('#OK', 200);
                } catch (e) {
                    // cleanup and abort
                    try { await disconnect(); } catch (_) { }
                    return;
                }

                // 3) send RUN
                await writeString(RUN_STR);

                // 4) wait for "#OK"
                try {
                    setStatus('OK received');
                    await readUntil('#OK', 200);
                } catch (e) {
                    try { await disconnect(); } catch (_) { }
                    return;
                }
            } else {
                setStatus('port not writable');
            }

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
    const speed_x = (dv.getInt16(off, littleEndian)) / 1000.0; off += 2;
    const speed_y = (dv.getInt16(off, littleEndian)) / 1000.0; off += 2;
    const rot_speed = (dv.getInt16(off, littleEndian)) / 1000.0; off += 2;
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

// In-memory list of status_payload objects (one element per robot id)
const statusArray = [];

// helper: ensure tree container exists
function ensureTreeContainer() {
    let container = document.getElementById('treeContent');
    if (!container) {
        const tree = document.createElement('aside');
        tree.id = 'tree';
        tree.setAttribute('aria-label', 'Robot tree');
        tree.style.position = 'fixed';
        tree.style.right = '12px';
        tree.style.top = '72px';
        tree.style.width = '260px';
        tree.style.maxHeight = 'calc(100vh - 84px)';
        tree.style.overflow = 'auto';
        tree.style.background = '#0f0f0f';
        tree.style.border = '1px solid #222';
        tree.style.borderRadius = '6px';
        tree.style.padding = '8px';
        tree.style.color = '#ddd';
        tree.style.boxShadow = '0 2px 8px rgba(0,0,0,0.6)';
        const h = document.createElement('h3');
        h.textContent = 'Robots';
        h.style.margin = '0 0 6px 0';
        h.style.color = '#9ad';
        tree.appendChild(h);
        container = document.createElement('div');
        container.id = 'treeContent';
        tree.appendChild(container);
        document.body.appendChild(tree);
    }
    return container;
}

// render detail HTML for a status object
function renderStatusDetailsHtml(s) {
    const lat = Number.isFinite(s.latitude) ? s.latitude.toFixed(6) : 'N/A';
    const lon = Number.isFinite(s.longitude) ? s.longitude.toFixed(6) : 'N/A';
    const heading = Number.isFinite(s.heading) ? s.heading.toFixed(3) : 'N/A';
    const cov = Number.isFinite(s.cov_pos) ? s.cov_pos.toFixed(3) : 'N/A';
    const spdX = (typeof s.speed_x !== 'undefined') ? s.speed_x : 'N/A';
    const spdY = (typeof s.speed_y !== 'undefined') ? s.speed_y : 'N/A';
    const rot = (typeof s.rot_speed !== 'undefined') ? s.rot_speed : 'N/A';
    const sync = (typeof s.sync_id !== 'undefined') ? s.sync_id : 'N/A';
    const time_off = (typeof s.time_offset_ms !== 'undefined') ? s.time_offset_ms : 'N/A';
    const drive_mode_hex = '0x' + (Number(s.drive_mode) || 0).toString(16).padStart(2, '0').toUpperCase();
    const aux_hex = '0x' + (Number(s.aux_data_status) || 0).toString(16).padStart(2, '0').toUpperCase();

    return `
    <div style="margin-left:4px; display:grid; grid-template-columns:90px 1fr; gap:3px; font-size:0.9em; color:#bbb;">
      <div style="text-align:right;padding-right:6px;">sync:</div><div>${sync}</div>
      <div style="text-align:right;padding-right:6px;">t_off:</div><div>${time_off} ms</div>
      <div style="text-align:right;padding-right:6px;">lat:</div><div>${lat}</div>
      <div style="text-align:right;padding-right:6px;">lon:</div><div>${lon}</div>
      <div style="text-align:right;padding-right:6px;">hdg:</div><div>${heading} rad</div>
      <div style="text-align:right;padding-right:6px;">cov:</div><div>${cov}</div>
      <div style="text-align:right;padding-right:6px;">spdX:</div><div>${spdX} mm/s</div>
      <div style="text-align:right;padding-right:6px;">spdY:</div><div>${spdY} mm/s</div>
      <div style="text-align:right;padding-right:6px;">rot:</div><div>${rot} mrad/s</div>
      <div style="text-align:right;padding-right:6px;">mode:</div><div>${drive_mode_hex}</div>
      <div style="text-align:right;padding-right:6px;">aux:</div><div>${aux_hex}</div>
    </div>
  `;
}

// create DOM entry (collapsed by default) and attach toggle handler
function createTreeEntry(s) {
    const container = ensureTreeContainer();
    const entry = document.createElement('div');
    entry.className = 'tree-entry';
    entry.dataset.id = String(s.id);
    entry.style.padding = '6px 8px';
    entry.style.borderBottom = '1px solid #111';
    entry.style.cursor = 'pointer';
    entry.style.color = '#ddd';

    const header = document.createElement('div');
    header.className = 'tree-header';
    header.style.fontWeight = '600';
    header.style.marginBottom = '6px';
    header.textContent = `ID ${s.id}`;
    entry.appendChild(header);

    const details = document.createElement('div');
    details.className = 'tree-details';
    details.style.display = s._expanded ? 'block' : 'none';
    details.innerHTML = renderStatusDetailsHtml(s);
    entry.appendChild(details);

    // toggle on click of header
    header.addEventListener('click', (ev) => {
        // prevent collapsing when clicking inside details accidentally
        ev.stopPropagation();
        s._expanded = !s._expanded;
        details.style.display = s._expanded ? 'block' : 'none';
    });

    // clicking the whole entry toggles too
    entry.addEventListener('click', () => {
        s._expanded = !s._expanded;
        details.style.display = s._expanded ? 'block' : 'none';
    });

    container.appendChild(entry);
    return entry;
}

// update details of existing DOM entry
function updateTreeEntryDom(s) {
    const container = ensureTreeContainer();
    const el = container.querySelector(`.tree-entry[data-id="${s.id}"]`);
    if (!el) return createTreeEntry(s);
    const details = el.querySelector('.tree-details');
    if (details) {
        details.innerHTML = renderStatusDetailsHtml(s);
        details.style.display = s._expanded ? 'block' : 'none';
    }
}

// rebuild entire tree (keeps current _expanded flags)
function renderStatusTree() {
    const container = ensureTreeContainer();
    container.innerHTML = '';
    for (let i = 0; i < statusArray.length; ++i) {
        const s = statusArray[i];
        // ensure _expanded boolean exists
        if (typeof s._expanded === 'undefined') s._expanded = false;
        createTreeEntry(s);
    }
}

/**
 * Update or insert status payload into statusArray using `id` as key.
 * - s: parsed status object { id, sync_id, ... }
 * If element exists, update its fields (preserve object reference).
 * If not, push a shallow copy.
 * Returns the array element.
 */
function updateStatusArray(s) {
    if (!s || typeof s.id === 'undefined') return null;
    const id = Number(s.id);
    const idx = statusArray.findIndex(item => Number(item.id) === id);
    if (idx >= 0) {
        // preserve expanded flag
        const expanded = !!statusArray[idx]._expanded;
        Object.assign(statusArray[idx], s);
        statusArray[idx]._expanded = expanded;
        updateTreeEntryDom(statusArray[idx]);
        // mark this id as active (only it will show the background)
        setActiveTreeId(id);
        // update marker on the map for this id
        //updateMapMarker(statusArray[idx]);
        return statusArray[idx];
    } else {
        const entry = Object.assign({}, s);
        entry._expanded = false;
        statusArray.push(entry);
        // create DOM entry for new element
        createTreeEntry(entry);
        // mark new id as active
        setActiveTreeId(id);
        // add marker for new entry
        //updateMapMarker(entry);
        return entry;
    }
}

// Optional helpers
function getStatusById(id) {
    return statusArray.find(item => Number(item.id) === Number(id)) || null;
}
function removeStatusById(id) {
    const idx = statusArray.findIndex(item => Number(item.id) === Number(id));
    if (idx >= 0) statusArray.splice(idx, 1);
}

// replace flashing helper with a single active-id setter that ensures only one entry
// has the active background at a time.
function setActiveTreeId(id, color = '#274C77') {
    const container = ensureTreeContainer();
    if (!container) return;

    // clear previous active background from all entries
    const entries = container.querySelectorAll('.tree-entry .tree-header');
    entries.forEach(h => {
        h.style.backgroundColor = '';
    });

    // set active background for the requested id
    const entry = container.querySelector(`.tree-entry[data-id="${id}"]`);
    if (!entry) return;
    const header = entry.querySelector('.tree-header') || entry;
    header.style.backgroundColor = color;
}

// Leaflet map + marker management
let map = null;
const markers = new Map(); // id -> L.Marker

function initMap() {
    if (map) return;
    // default view
    map = L.map('map', { preferCanvas: true }).setView([0, 0], 2);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; OpenStreetMap contributors'
    }).addTo(map);
}

function updateMapMarker(s) {
    if (!s || typeof s.latitude !== 'number' || typeof s.longitude !== 'number') return;
    const lat = Number(s.latitude);
    const lon = Number(s.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;

    // create marker if missing
    let m = markers.get(s.id);
    const popupHtml = `
    <strong>ID ${s.id}</strong><br/>
    sync: ${s.sync_id} &nbsp; t_off: ${s.time_offset_ms} ms<br/>
    lat: ${lat.toFixed(6)}<br/>lon: ${lon.toFixed(6)}<br/>
    hdg: ${s.heading?.toFixed(3) ?? 'N/A'} rad<br/>
    cov: ${s.cov_pos ?? 'N/A'}<br/>
    spdX: ${s.speed_x ?? 'N/A'} mm/s
  `;
    if (!m) {
        m = L.marker([lat, lon]);
        m.addTo(map).bindPopup(popupHtml);
        markers.set(s.id, m);
    } else {
        m.setLatLng([lat, lon]);
        m.getPopup()?.setContent(popupHtml);
    }
}

// ensure map is initialized once DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    initMap();
});