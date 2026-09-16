// Powered by Angelo Martelli

if (typeof pdfjsLib !== 'undefined') {
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.14.305/pdf.worker.min.js';
}

let route = [];
let currentStageIndex = 0;
let pdfDoc = null;

let totalKmTraveled = 0.0;
let tripKmTraveled = 0.0;
let lastCoords = null;
let watchId = null;
let wakeLock = null;
let isAutoAdvancing = false;

// Gestione Mappe: Traccia prevista (Arancione) e Traccia effettuata (Azzurra)
let map = null;
let userMarker = null;
let plannedPolyline = null; // Traccia GPX completa
let livePolyline = null;    // Traccia percorsa in tempo reale
let livePathCoords = [];    // Coordinate registrate dal GPS
let currentCoords = null;

// Context Web Audio
let audioCtx = null;
let fallbackVideoEl = null;

// VERIFICA DISLIVELLO
function isDislivelloText(text) {
  if (!text) return false;
  const clean = text.toLowerCase().trim();
  const dislivelloRegex = /(m\.?\s*dis\.?|m\.?\s*d\.?\s*l\.?|dislivello|disl|d\+|d\-|\+|-|alt|quota|m\.s\.l\.m)/i;
  return dislivelloRegex.test(clean);
}

// BEEP ACUSTICO ZERO
function playAlertBeep() {
  try {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioCtx.state === 'suspended') {
      audioCtx.resume();
    }
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();

    osc.type = "sine";
    osc.frequency.setValueAtTime(880, audioCtx.currentTime);
    
    gain.gain.setValueAtTime(0.1, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.8, audioCtx.currentTime + 0.05);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.35);

    osc.connect(gain);
    gain.connect(audioCtx.destination);

    osc.start(audioCtx.currentTime);
    osc.stop(audioCtx.currentTime + 0.35);
  } catch (e) {
    console.warn("Audio non supportato:", e);
  }
}

// INIZIALIZZAZIONE
document.addEventListener("DOMContentLoaded", () => {
  if (document.body.classList.contains("page-dashboard")) {
    initDashboard();
  }
});

function initDashboard() {
  const storedRoute = sessionStorage.getItem("roadbook_route");
  const storedPdfData = sessionStorage.getItem("roadbook_pdf_data");

  if (!storedRoute) {
    window.location.href = "../index.html";
    return;
  }

  route = JSON.parse(storedRoute);
  initMap();

  if (storedPdfData) {
    const pdfArray = new Uint8Array(JSON.parse(storedPdfData));
    pdfjsLib.getDocument(pdfArray).promise.then(doc => {
      pdfDoc = doc;
      updateStageDisplay();
      startGPS();
    }).catch(() => {
      window.location.href = "../index.html";
    });
  } else {
    updateStageDisplay();
    startGPS();
  }

  document.addEventListener("touchstart", handleUserInteraction, { once: true });
  document.addEventListener("click", handleUserInteraction, { once: true });
}

function handleUserInteraction() {
  requestWakeLock();
  if (audioCtx && audioCtx.state === 'suspended') {
    audioCtx.resume();
  }
}

// ---------------------------------------------------------
// MAPPA & TRACKING IN TEMPO REALE
// ---------------------------------------------------------
function initMap() {
  const mapEl = document.getElementById("map");
  if (!mapEl) return;

  map = L.map('map', { zoomControl: false, attributionControl: false }).setView([41.9028, 12.4964], 13);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(map);

  // 1. Disegna la traccia GPX completa se presente (Sfondo Arancione)
  const storedPath = sessionStorage.getItem("roadbook_gpx_path");
  if (storedPath) {
    try {
      const gpxCoords = JSON.parse(storedPath);
      if (gpxCoords.length > 0) {
        plannedPolyline = L.polyline(gpxCoords, {
          color: '#ff9800',
          weight: 6,
          opacity: 0.7,
          lineJoin: 'round'
        }).addTo(map);

        map.fitBounds(plannedPolyline.getBounds(), { padding: [20, 20] });
      }
    } catch (e) {
      console.warn("Errore nel caricamento del percorso GPX", e);
    }
  }

  // 2. Prepara la linea azzurra per il percorso effettuato in tempo reale (GPX, PDF o Immagine)
  livePolyline = L.polyline([], {
    color: '#00b0ff',
    weight: 6,
    opacity: 0.95,
    lineJoin: 'round'
  }).addTo(map);
}

function updateMapPosition(lat, lng) {
  if (!map) return;

  currentCoords = { lat, lng };

  // Aggiorna o crea il marcatore del veicolo
  if (!userMarker) {
    userMarker = L.circleMarker([lat, lng], {
      color: '#ffffff',
      weight: 2,
      fillColor: '#00e676',
      fillOpacity: 1,
      radius: 9
    }).addTo(map);
    
    if (!plannedPolyline) {
      map.setView([lat, lng], 16);
    }
  } else {
    userMarker.setLatLng([lat, lng]);
  }

  // Aggiunge la nuova posizione alla linea azzurra in tempo reale
  livePathCoords.push([lat, lng]);
  if (livePolyline) {
    livePolyline.setLatLngs(livePathCoords);
  }
}

function recenterMap() {
  if (!map) return;

  if (currentCoords) {
    map.flyTo([currentCoords.lat, currentCoords.lng], 16, { animate: true, duration: 0.8 });
  } else {
    alert("In attesa del segnale GPS...");
  }
}

// ---------------------------------------------------------
// OPTION 1: LOAD ROADBOOK (PDF / JPG, PNG, HEIC)
// ---------------------------------------------------------
async function loadRoadbook(event) {
  let file = event.target.files[0];
  if (!file) return;

  const statusEl = document.getElementById("upload-status");
  const fileName = file.name.toLowerCase();

  if (fileName.endsWith(".heic") || file.type === "image/heic") {
    if (statusEl) statusEl.innerText = "Conversione formato HEIC iPhone in corso...";
    try {
      const convertedBlob = await heic2any({ blob: file, toType: "image/jpeg", quality: 0.8 });
      const resultBlob = Array.isArray(convertedBlob) ? convertedBlob[0] : convertedBlob;
      file = new File([resultBlob], "converted.jpg", { type: "image/jpeg" });
    } catch (error) {
      if (statusEl) statusEl.innerText = "Errore nella conversione HEIC.";
      return;
    }
  }

  if (file.type.startsWith("image/")) {
    if (statusEl) statusEl.innerText = "Analisi OCR Immagine in corso...";
    const reader = new FileReader();
    reader.onload = async function(e) {
      const imageDataUrl = e.target.result;
      try {
        const worker = await Tesseract.createWorker('ita');
        const ret = await worker.recognize(imageDataUrl);
        await worker.terminate();

        const extractedText = ret.data.text;
        const lines = extractedText.split('\n').filter(l => l.trim().length > 0);

        let extractedStages = [];
        let validDistances = [];

        lines.forEach(line => {
          if (isDislivelloText(line)) return;
          const numMatches = line.match(/\b\d+([.,]\d+)?\b/g);
          if (numMatches) {
            numMatches.forEach(m => {
              const val = parseFloat(m.replace(',', '.'));
              if (val > 0) validDistances.push(val);
            });
          }
        });

        let parzialeMetri = validDistances.length >= 2 ? Math.min(...validDistances) : (validDistances[0] || 0);
        let totaleMetri = validDistances.length >= 2 ? Math.max(...validDistances) : (validDistances[0] || 0);
        let noteText = lines.find(l => /[a-zA-Z]{3,}/.test(l) && !isDislivelloText(l)) || "INSERISCI DIREZIONE";

        extractedStages.push({
          nota: 1, text: noteText, parziale: parzialeMetri, totale: totaleMetri, isImage: true, imageData: imageDataUrl
        });

        sessionStorage.setItem("roadbook_route", JSON.stringify(extractedStages));
        sessionStorage.removeItem("roadbook_pdf_data");
        sessionStorage.removeItem("roadbook_gpx_path");
        window.location.href = "src/dashboard.html";
      } catch (err) {
        if (statusEl) statusEl.innerText = "Errore durante l'analisi dell'immagine.";
      }
    };
    reader.readAsDataURL(file);
    return;
  }

  if (file.type === "application/pdf") {
    loadPDF(file);
  }
}

async function loadPDF(file) {
  const statusEl = document.getElementById("upload-status");
  if (statusEl) statusEl.innerText = "Analisi Roadbook PDF in corso...";

  const fileReader = new FileReader();
  fileReader.onload = async function() {
    const typedarray = new Uint8Array(this.result);
    try {
      pdfDoc = await pdfjsLib.getDocument(typedarray).promise;
      let allItems = [];
      let extractedStages = [];

      for (let i = 1; i <= pdfDoc.numPages; i++) {
        const page = await pdfDoc.getPage(i);
        const textContent = await page.getTextContent();
        textContent.items.forEach(item => {
          const str = item.str.trim();
          if (str.length > 0) allItems.push({ text: str, page: i, transform: item.transform });
        });
      }

      for (let i = 0; i < allItems.length; i++) {
        let entry = allItems[i];
        if (/^\d{1,3}$/.test(entry.text)) {
          let notaNum = parseInt(entry.text);
          if (notaNum > 0 && notaNum < 200) {
            let noteText = "SEGUI STRADA";
            let distanceValues = [];
            let yPosition = entry.transform ? entry.transform[5] : 0;

            for (let j = Math.max(0, i - 4); j < Math.min(allItems.length, i + 6); j++) {
              let contextItem = allItems[j].text;
              if (isDislivelloText(contextItem)) continue;
              if (/[A-Z]{3,}/.test(contextItem) && !contextItem.includes("AUTOSTRADA")) noteText = contextItem;
              if (/^\d{1,2}[.,]\d{2,3}$/.test(contextItem)) distanceValues.push(parseFloat(contextItem.replace(',', '.')));
            }

            if (!extractedStages.some(s => s.nota === notaNum)) {
              let parziale = distanceValues.length >= 2 ? Math.min(...distanceValues) : (distanceValues[0] || 0);
              let totale = distanceValues.length >= 2 ? Math.max(...distanceValues) : (distanceValues[0] || 0);

              extractedStages.push({ nota: notaNum, text: noteText, parziale: parziale, totale: totale, page: entry.page, yPos: yPosition });
            }
          }
        }
      }

      if (extractedStages.length > 0) {
        extractedStages.sort((a, b) => a.nota - b.nota);
        sessionStorage.setItem("roadbook_route", JSON.stringify(extractedStages));
        sessionStorage.setItem("roadbook_pdf_data", JSON.stringify(Array.from(typedarray)));
        sessionStorage.removeItem("roadbook_gpx_path");
        window.location.href = "src/dashboard.html";
      } else {
        if (statusEl) statusEl.innerText = "Nessuna nota trovata nel PDF.";
      }
    } catch (err) {
      if (statusEl) statusEl.innerText = "Errore lettura PDF.";
    }
  };
  fileReader.readAsArrayBuffer(file);
}

// ---------------------------------------------------------
// OPTION 2: LOAD TRACCIA GPS (GPX DA OSMAND / WIKILOC / GARMIN)
// ---------------------------------------------------------
function loadGPXFile(event) {
  const file = event.target.files[0];
  if (!file) return;

  const statusEl = document.getElementById("upload-status");
  if (statusEl) statusEl.innerText = "Elaborazione Traccia GPX in corso...";

  const reader = new FileReader();
  reader.onload = function(e) {
    const text = e.target.result;
    const parser = new DOMParser();
    const xmlDoc = parser.parseFromString(text, "text/xml");

    let extractedStages = [];
    let fullTrackPoints = [];
    let cumulativeDist = 0.0;
    let lastPt = null;

    const trackPoints = xmlDoc.querySelectorAll("trkpt");
    trackPoints.forEach((pt) => {
      const lat = parseFloat(pt.getAttribute("lat"));
      const lon = parseFloat(pt.getAttribute("lon"));
      if (!isNaN(lat) && !isNaN(lon)) {
        fullTrackPoints.push([lat, lon]);
      }
    });

    const waypoints = xmlDoc.querySelectorAll("wpt");

    if (waypoints.length > 0) {
      waypoints.forEach((wpt, index) => {
        const lat = parseFloat(wpt.getAttribute("lat"));
        const lon = parseFloat(wpt.getAttribute("lon"));
        const nameEl = wpt.querySelector("name") || wpt.querySelector("cmt") || wpt.querySelector("desc");
        const symEl = wpt.querySelector("sym") || wpt.querySelector("type");

        let noteText = nameEl ? nameEl.textContent : `Svolta ${index + 1}`;
        let symType = symEl ? symEl.textContent.toLowerCase() : "turn";

        let segmentDist = lastPt ? calculateDistance(lastPt.lat, lastPt.lon, lat, lon) : 0.0;
        cumulativeDist += segmentDist;
        lastPt = { lat, lon };

        extractedStages.push({
          nota: index + 1,
          text: noteText,
          parziale: segmentDist,
          totale: cumulativeDist,
          isGpxIcon: true,
          iconType: symType,
          lat: lat,
          lon: lon
        });
      });
    }

    if (extractedStages.length === 0 && trackPoints.length > 0) {
      let pointIndex = 0;
      lastPt = null;

      trackPoints.forEach((pt) => {
        const lat = parseFloat(pt.getAttribute("lat"));
        const lon = parseFloat(pt.getAttribute("lon"));

        let segmentDist = lastPt ? calculateDistance(lastPt.lat, lastPt.lon, lat, lon) : 0.0;

        if (!lastPt || segmentDist >= 0.3) {
          cumulativeDist += segmentDist;
          lastPt = { lat, lon };
          pointIndex++;

          extractedStages.push({
            nota: pointIndex,
            text: `Punto Traccia ${pointIndex}`,
            parziale: segmentDist,
            totale: cumulativeDist,
            isGpxIcon: true,
            iconType: "straight",
            lat: lat,
            lon: lon
          });
        }
      });
    }

    if (extractedStages.length > 0) {
      sessionStorage.setItem("roadbook_route", JSON.stringify(extractedStages));
      sessionStorage.setItem("roadbook_gpx_path", JSON.stringify(fullTrackPoints));
      sessionStorage.removeItem("roadbook_pdf_data");
      window.location.href = "src/dashboard.html";
    } else {
      if (statusEl) statusEl.innerText = "File GPX vuoto o non valido.";
    }
  };
  reader.readAsText(file);
}

function clearPDF() {
  sessionStorage.removeItem("roadbook_route");
  sessionStorage.removeItem("roadbook_pdf_data");
  sessionStorage.removeItem("roadbook_gpx_path");
  window.location.href = "../index.html";
}

// RENDER FRECCIA / GRAFICA DIREZIONE
async function renderStageGraphic(stage) {
  const box = document.getElementById("current-direction-box");
  if (!box) return;
  box.innerHTML = "";

  if (stage.isGpxIcon) {
    let iconSvg = "⬆️";
    const type = stage.iconType || "";
    if (type.includes("left") || type.includes("sinistra")) iconSvg = "⬅️";
    else if (type.includes("right") || type.includes("destra")) iconSvg = "➡️";
    else if (type.includes("sharp_left")) iconSvg = "↖️";
    else if (type.includes("sharp_right")) iconSvg = "↗️";

    box.innerHTML = `<div style="font-size: 3.5rem; display: flex; align-items: center; justify-content: center; height: 100%;">${iconSvg}</div>`;
    return;
  }

  if (stage.isImage && stage.imageData) {
    try {
      const croppedImageBase64 = await extractDirectionFromImage(stage.imageData);
      const img = document.createElement("img");
      img.src = croppedImageBase64;
      img.style.maxWidth = "100%";
      img.style.maxHeight = "100%";
      img.style.objectFit = "contain";
      box.appendChild(img);
    } catch (e) {
      box.innerHTML = `<span style="font-size:2rem;">📍</span>`;
    }
    return;
  }

  if (!pdfDoc || !stage.page) {
    box.innerHTML = `<span style="font-size:2rem;">📍</span>`;
    return;
  }

  try {
    const page = await pdfDoc.getPage(stage.page);
    const scale = 3.0;
    const viewport = page.getViewport({ scale: scale });

    const fullCanvas = document.createElement("canvas");
    const fullCtx = fullCanvas.getContext("2d");
    fullCanvas.width = viewport.width;
    fullCanvas.height = viewport.height;

    await page.render({ canvasContext: fullCtx, viewport: viewport }).promise;

    const unscaledViewport = page.getViewport({ scale: 1.0 });
    const pdfYFromTop = unscaledViewport.height - stage.yPos;
    
    const boxHeight = 70 * scale;
    const boxWidth = 90 * scale;
    
    let cropY = (pdfYFromTop * scale) - (boxHeight / 2);
    let cropX = (viewport.width * 0.50) - (boxWidth / 2);

    cropY = Math.max(0, Math.min(cropY, viewport.height - boxHeight));

    const cropCanvas = document.createElement("canvas");
    const cropCtx = cropCanvas.getContext("2d");
    cropCanvas.width = boxWidth;
    cropCanvas.height = boxHeight;

    cropCtx.drawImage(
      fullCanvas,
      cropX, cropY, boxWidth, boxHeight,
      0, 0, boxWidth, boxHeight
    );

    cropCanvas.style.maxWidth = "100%";
    cropCanvas.style.maxHeight = "100%";
    cropCanvas.style.objectFit = "contain";
    cropCanvas.style.borderRadius = "6px";

    box.appendChild(cropCanvas);
  } catch (e) {
    box.innerHTML = `<span style="font-size:2rem;">🛠️</span>`;
  }
}

async function extractDirectionFromImage(imageDataUrl) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d");
      canvas.width = img.width;
      canvas.height = img.height;
      ctx.drawImage(img, 0, 0);

      const cropX = img.width * 0.35;
      const cropWidth = img.width * 0.25;
      const cropY = img.height * 0.10;
      const cropHeight = img.height * 0.80;

      const cropCanvas = document.createElement("canvas");
      const cropCtx = cropCanvas.getContext("2d");
      cropCanvas.width = cropWidth;
      cropCanvas.height = cropHeight;

      cropCtx.drawImage(canvas, cropX, cropY, cropWidth, cropHeight, 0, 0, cropWidth, cropHeight);
      resolve(cropCanvas.toDataURL("image/jpeg"));
    };
    img.src = imageDataUrl;
  });
}

// DASHBOARD E AVANZAMENTO
function updateStageDisplay() {
  if (route.length === 0) return;

  const current = route[currentStageIndex];
  const next = (currentStageIndex + 1 < route.length) ? route[currentStageIndex + 1] : null;

  document.getElementById("current-stage-num").innerText = `Nota Attuale (${current.nota} / ${route.length})`;
  document.getElementById("current-stage-name").innerText = current.text;
  document.getElementById("current-stage-target").innerText = `Target Parz: ${current.parziale.toFixed(2)} km | Tot: ${current.totale.toFixed(2)} km`;

  renderStageGraphic(current);

  if (next) {
    document.getElementById("next-stage-name").innerText = `Nota ${next.nota}: ${next.text}`;
    document.getElementById("next-stage-target").innerText = `Target Parz: ${next.parziale.toFixed(2)} km | Tot: ${next.totale.toFixed(2)} km`;
  } else {
    document.getElementById("next-stage-name").innerText = "FINE ROADBOOK 🏁";
    document.getElementById("next-stage-target").innerText = "-";
  }

  updateDisplays();
}

function updateDisplays() {
  if (route.length === 0) return;

  const current = route[currentStageIndex];
  let remainingTrip = current.parziale - tripKmTraveled;

  if (remainingTrip <= 0 && current.parziale > 0 && !isAutoAdvancing) {
    isAutoAdvancing = true;
    playAlertBeep();

    if (currentStageIndex < route.length - 1) {
      currentStageIndex++;
      tripKmTraveled = 0.0;
      setTimeout(() => { updateStageDisplay(); isAutoAdvancing = false; }, 500);
      return;
    } else {
      remainingTrip = 0;
    }
  }

  if (remainingTrip < 0) remainingTrip = 0;
  document.getElementById("trip-countdown").innerText = remainingTrip.toFixed(2);
  document.getElementById("total-traveled").innerText = totalKmTraveled.toFixed(2);
}

// GPS & DISTANZE
function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return R * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

function handlePosition(position) {
  const { latitude, longitude, accuracy } = position.coords;

  const gpsEl = document.getElementById("status-text");
  if (gpsEl) {
    gpsEl.innerText = `GPS: ±${Math.round(accuracy)}m`;
    gpsEl.style.color = "#00e676";
  }

  updateMapPosition(latitude, longitude);

  if (lastCoords) {
    const dist = calculateDistance(lastCoords.latitude, lastCoords.longitude, latitude, longitude);
    if (dist > 0.003 && accuracy < 30) {
      totalKmTraveled += dist;
      tripKmTraveled += dist;
      updateDisplays();
      lastCoords = { latitude, longitude };
    }
  } else {
    lastCoords = { latitude, longitude };
  }
}

// WAKE LOCK & SAFARI FALLBACK
async function requestWakeLock() {
  const lockEl = document.getElementById("wakelock-text");
  if ('wakeLock' in navigator) {
    try {
      if (!wakeLock) {
        wakeLock = await navigator.wakeLock.request('screen');
        if (lockEl) { lockEl.innerText = "Schermo: Attivo 💡"; lockEl.style.color = "#00e676"; }
        wakeLock.addEventListener('release', () => { wakeLock = null; });
      }
      return;
    } catch (err) {}
  }
  startSafariVideoFallback(lockEl);
}

function startSafariVideoFallback(lockEl) {
  if (!fallbackVideoEl) {
    fallbackVideoEl = document.createElement("video");
    fallbackVideoEl.setAttribute("playsinline", "");
    fallbackVideoEl.setAttribute("muted", "");
    fallbackVideoEl.setAttribute("loop", "");
    fallbackVideoEl.style.position = "absolute";
    fallbackVideoEl.style.width = "1px";
    fallbackVideoEl.style.height = "1px";
    fallbackVideoEl.style.opacity = "0.01";
    fallbackVideoEl.src = "data:video/mp4;base64,AAAAIGZ0eXBpc29tAAACAGlzb21pc28ybXA0MQAAAAhmcmVlAAAAAG1kYXQ=";
    document.body.appendChild(fallbackVideoEl);
  }
  fallbackVideoEl.play().then(() => {
    if (lockEl) { lockEl.innerText = "Schermo: Attivo (iOS) 💡"; lockEl.style.color = "#00e676"; }
  });
}

document.addEventListener("visibilitychange", async () => {
  if (document.visibilityState === "visible") await requestWakeLock();
});

function startGPS() {
  if ("geolocation" in navigator && !watchId) {
    watchId = navigator.geolocation.watchPosition(handlePosition, null, { enableHighAccuracy: true, maximumAge: 1000, timeout: 10000 });
    requestWakeLock();
  }
}
