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

// Variabili Mappa
let map = null;
let userMarker = null;

// Context Web Audio per il suono di avviso
let audioCtx = null;

// Elemento Video Fallback per Safari iOS
let fallbackVideoEl = null;

// VERIFICA SE UNA STRINGA SI RIFERISCE AL DISLIVELLO
function isDislivelloText(text) {
  if (!text) return false;
  const clean = text.toLowerCase().trim();
  const dislivelloRegex = /(m\.?\s*dis\.?|m\.?\s*d\.?\s*l\.?|dislivello|disl|d\+|d\-|\+|-|alt|quota|m\.s\.l\.m)/i;
  return dislivelloRegex.test(clean);
}

// SINTETIZZATORE SUONO DI AVVISO (Bip al raggiungimento dello 0)
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
    console.warn("Impossibile riprodurre il segnale acustico:", e);
  }
}

// INIZIALIZZAZIONE
document.addEventListener("DOMContentLoaded", () => {
  if (document.body.classList.contains("page-dashboard")) {
    initDashboard();
  }
});

// INIZIALIZZA DASHBOARD
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

  // Sblocco interazione utente per audio e wake lock su iOS Safari
  document.addEventListener("touchstart", handleUserInteraction, { once: true });
  document.addEventListener("click", handleUserInteraction, { once: true });
}

function handleUserInteraction() {
  requestWakeLock();
  if (audioCtx && audioCtx.state === 'suspended') {
    audioCtx.resume();
  }
}

// INIZIALIZZA MAPPA (Leaflet / OpenStreetMap)
function initMap() {
  const mapEl = document.getElementById("map");
  if (!mapEl) return;

  map = L.map('map', {
    zoomControl: false,
    attributionControl: false
  }).setView([41.9028, 12.4964], 13);

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19
  }).addTo(map);
}

// AGGIORNA POSIZIONE MAPPA
function updateMapPosition(lat, lng) {
  if (!map) return;

  if (!userMarker) {
    userMarker = L.circleMarker([lat, lng], {
      color: '#00e676',
      fillColor: '#00e676',
      fillOpacity: 0.8,
      radius: 8
    }).addTo(map);
    map.setView([lat, lng], 16);
  } else {
    userMarker.setLatLng([lat, lng]);
    map.panTo([lat, lng]);
  }
}

// CARICAMENTO UNIVERSELE CON CONTROLLO ESCLUSIVO METRI PARZIALI
async function loadRoadbook(event) {
  let file = event.target.files[0];
  if (!file) return;

  const statusEl = document.getElementById("upload-status");
  const fileName = file.name.toLowerCase();

  // 1. Conversione HEIC iPhone
  if (fileName.endsWith(".heic") || file.type === "image/heic") {
    if (statusEl) statusEl.innerText = "Conversione formato HEIC iPhone in corso...";

    try {
      const convertedBlob = await heic2any({
        blob: file,
        toType: "image/jpeg",
        quality: 0.8
      });

      const resultBlob = Array.isArray(convertedBlob) ? convertedBlob[0] : convertedBlob;
      file = new File([resultBlob], "converted.jpg", { type: "image/jpeg" });
    } catch (error) {
      if (statusEl) statusEl.innerText = "Errore nella conversione HEIC.";
      return;
    }
  }

  // 2. Elaborazione ed Estrazione Dati da IMMAGINI (OCR Tesseract)
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

        let parzialeMetri = 0.0;
        let totaleMetri = 0.0;

        if (validDistances.length >= 2) {
          parzialeMetri = Math.min(...validDistances);
          totaleMetri = Math.max(...validDistances);
        } else if (validDistances.length === 1) {
          parzialeMetri = validDistances[0];
          totaleMetri = validDistances[0];
        }

        let noteText = lines.find(l => /[a-zA-Z]{3,}/.test(l) && !isDislivelloText(l)) || "INSERISCI DIREZIONE";

        extractedStages.push({
          nota: 1,
          text: noteText,
          parziale: parzialeMetri,
          totale: totaleMetri,
          isImage: true,
          imageData: imageDataUrl
        });

        sessionStorage.setItem("roadbook_route", JSON.stringify(extractedStages));
        sessionStorage.removeItem("roadbook_pdf_data");

        window.location.href = "src/dashboard.html";
      } catch (err) {
        if (statusEl) statusEl.innerText = "Errore durante l'analisi OCR dell'immagine.";
      }
    };
    reader.readAsDataURL(file);
    return;
  }

  // 3. Elaborazione ed Estrazione Dati da PDF
  if (file.type === "application/pdf") {
    loadPDF(file);
  } else {
    if (statusEl) statusEl.innerText = "Formato non supportato. Usa PDF, JPG, PNG o HEIC.";
  }
}

// PARSING E RILEVAMENTO TAPPE DA PDF
async function loadPDF(file) {
  const statusEl = document.getElementById("upload-status");
  if (statusEl) statusEl.innerText = "Analisi Roadbook PDF in corso...";

  const fileReader = new FileReader();
  fileReader.onload = async function() {
    const arrayBuffer = this.result;
    const typedarray = new Uint8Array(arrayBuffer);
    
    try {
      pdfDoc = await pdfjsLib.getDocument(typedarray).promise;
      let allItems = [];
      let extractedStages = [];

      for (let i = 1; i <= pdfDoc.numPages; i++) {
        const page = await pdfDoc.getPage(i);
        const textContent = await page.getTextContent();
        
        textContent.items.forEach(item => {
          const str = item.str.trim();
          if (str.length > 0) {
            allItems.push({ 
              text: str, 
              page: i,
              transform: item.transform
            });
          }
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
              
              if (isDislivelloText(contextItem)) {
                continue;
              }

              if (/[A-Z]{3,}/.test(contextItem) && !contextItem.includes("AUTOSTRADA") && !contextItem.includes("DISTANZE")) {
                noteText = contextItem;
              }
              
              if (/^\d{1,2}[.,]\d{2,3}$/.test(contextItem)) {
                distanceValues.push(parseFloat(contextItem.replace(',', '.')));
              }
            }

            if (!extractedStages.some(s => s.nota === notaNum)) {
              let parziale = 0.0;
              let totale = 0.0;

              if (distanceValues.length >= 2) {
                parziale = Math.min(...distanceValues);
                totale = Math.max(...distanceValues);
              } else if (distanceValues.length === 1) {
                parziale = distanceValues[0];
                totale = distanceValues[0];
              }

              extractedStages.push({
                nota: notaNum,
                text: noteText,
                parziale: parziale,
                totale: totale,
                page: entry.page,
                yPos: yPosition
              });
            }
          }
        }
      }

      if (extractedStages.length > 0) {
        extractedStages.sort((a, b) => a.nota - b.nota);
        
        sessionStorage.setItem("roadbook_route", JSON.stringify(extractedStages));
        sessionStorage.setItem("roadbook_pdf_data", JSON.stringify(Array.from(typedarray)));
        
        window.location.href = "src/dashboard.html";
      } else {
        if (statusEl) statusEl.innerText = "Nessuna nota riconosciuta nel PDF.";
      }
    } catch (err) {
      if (statusEl) statusEl.innerText = "Errore lettura PDF: " + err.message;
    }
  };

  fileReader.readAsArrayBuffer(file);
}

function clearPDF() {
  sessionStorage.removeItem("roadbook_route");
  sessionStorage.removeItem("roadbook_pdf_data");
  window.location.href = "../index.html";
}

// ESTRAZIONE DINAMICA DELLA FRECCIA DA IMMAGINE
async function extractDirectionFromImage(imageDataUrl) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d");
      canvas.width = img.width;
      canvas.height = img.height;
      ctx.drawImage(img, 0, 0);

      // Ritaglio focalizzato sulla colonna centrale dell'immagine
      const cropX = img.width * 0.35;
      const cropWidth = img.width * 0.25;
      const cropY = img.height * 0.10;
      const cropHeight = img.height * 0.80;

      const cropCanvas = document.createElement("canvas");
      const cropCtx = cropCanvas.getContext("2d");
      cropCanvas.width = cropWidth;
      cropCanvas.height = cropHeight;

      cropCtx.drawImage(
        canvas,
        cropX, cropY, cropWidth, cropHeight,
        0, 0, cropWidth, cropHeight
      );

      resolve(cropCanvas.toDataURL());
    };
    img.src = imageDataUrl;
  });
}

// RENDER ADATTIVO ED ISOLATO DELLA FRECCIA DI DIREZIONE (PDF & IMMAGINI)
async function renderStageGraphic(stage) {
  const box = document.getElementById("current-direction-box");
  if (!box) return;
  box.innerHTML = "";

  // 1. Gestione per file caricati come IMMAGINE
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

  // 2. Gestione DINAMICA per file PDF
  try {
    const page = await pdfDoc.getPage(stage.page);
    const scale = 3.0;
    const viewport = page.getViewport({ scale: scale });

    const textContent = await page.getTextContent();
    const pageItems = textContent.items;

    let stageY = stage.yPos;
    let minX_AfterText = viewport.width;
    let maxX_BeforeText = 0;

    // Calcolo dinamico dello spazio libero tra le colonne di testo
    pageItems.forEach(item => {
      const itemY = item.transform[5];
      const itemX = item.transform[4] * scale;
      const itemWidth = (item.width || 0) * scale;

      if (Math.abs(itemY - stageY) < 25) {
        if (itemX < viewport.width * 0.5) {
          if ((itemX + itemWidth) > maxX_BeforeText) {
            maxX_BeforeText = itemX + itemWidth;
          }
        } else {
          if (itemX < minX_AfterText) {
            minX_AfterText = itemX;
          }
        }
      }
    });

    const fullCanvas = document.createElement("canvas");
    const fullCtx = fullCanvas.getContext("2d");
    fullCanvas.width = viewport.width;
    fullCanvas.height = viewport.height;

    await page.render({ canvasContext: fullCtx, viewport: viewport }).promise;

    let cropX, cropWidth;

    if (maxX_BeforeText > 0 && minX_AfterText < viewport.width && minX_AfterText > maxX_BeforeText) {
      cropX = maxX_BeforeText + 10;
      cropWidth = (minX_AfterText - maxX_BeforeText) - 20;
    } else {
      cropX = viewport.width * 0.42;
      cropWidth = viewport.width * 0.18;
    }

    const rowHeight = viewport.height / 12; 
    let cropY = (viewport.height - (stageY * scale)) - (rowHeight * 0.4);
    if (cropY < 0 || isNaN(cropY)) cropY = viewport.height * 0.2;

    cropWidth = Math.max(cropWidth, 50);

    const cropCanvas = document.createElement("canvas");
    const cropCtx = cropCanvas.getContext("2d");

    cropCanvas.width = cropWidth;
    cropCanvas.height = rowHeight;

    cropCtx.drawImage(
      fullCanvas,
      cropX, cropY, cropWidth, rowHeight,
      0, 0, cropWidth, rowHeight
    );

    cropCanvas.style.maxWidth = "100%";
    cropCanvas.style.maxHeight = "100%";
    cropCanvas.style.objectFit = "contain";

    box.appendChild(cropCanvas);
  } catch (e) {
    box.innerHTML = `<span style="font-size:2rem;">🛠️</span>`;
  }
}

// AGGIORNA VISUALIZZAZIONE NOTA NELLA DASHBOARD
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

// AGGIORNA CONTATORI E AVANZAMENTO AUTOMATICO CON AVVISO SONORO
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
      
      setTimeout(() => {
        updateStageDisplay();
        isAutoAdvancing = false;
      }, 500);
      return;
    } else {
      remainingTrip = 0;
    }
  }

  if (remainingTrip < 0) remainingTrip = 0;

  const countdownEl = document.getElementById("trip-countdown");
  const totalEl = document.getElementById("total-traveled");

  if (countdownEl) countdownEl.innerText = remainingTrip.toFixed(2);
  if (totalEl) totalEl.innerText = totalKmTraveled.toFixed(2);
}

// DISTANZA GPS
function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = 
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * 
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// POSIZIONE GPS
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

// GESTIONE SCHERMO ATTIVO (NATIVE WAKE LOCK + SAFARI FALLBACK)
async function requestWakeLock() {
  const lockEl = document.getElementById("wakelock-text");

  if ('wakeLock' in navigator) {
    try {
      if (!wakeLock) {
        wakeLock = await navigator.wakeLock.request('screen');
        if (lockEl) {
          lockEl.innerText = "Schermo: Attivo 💡";
          lockEl.style.color = "#00e676";
        }

        wakeLock.addEventListener('release', () => {
          wakeLock = null;
        });
      }
      return;
    } catch (err) {
      console.warn("Wake Lock nativo rifiutato, attivo fallback per Safari iOS...", err);
    }
  }

  startSafariVideoFallback(lockEl);
}

// FALLBACK SAFARI iOS: Video Trasparente in Loop
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
    fallbackVideoEl.style.pointerEvents = "none";
    
    fallbackVideoEl.src = "data:video/mp4;base64,AAAAIGZ0eXBpc29tAAACAGlzb21pc28ybXA0MQAAAAhmcmVlAAAAAG1kYXQ=";
    document.body.appendChild(fallbackVideoEl);
  }

  fallbackVideoEl.play().then(() => {
    if (lockEl) {
      lockEl.innerText = "Schermo: Attivo (iOS) 💡";
      lockEl.style.color = "#00e676";
    }
  }).catch(() => {
    if (lockEl) {
      lockEl.innerText = "Schermo: Tocca lo schermo ⚠️";
      lockEl.style.color = "#ffb300";
    }
  });
}

// RIPRISTINO AUTOMATICO SCHERMO ATTIVO SU SAFARI QUANDO L'APP TORNA IN PRIMO PIANO
document.addEventListener("visibilitychange", async () => {
  if (document.visibilityState === "visible") {
    await requestWakeLock();
  }
});

function startGPS() {
  if ("geolocation" in navigator && !watchId) {
    watchId = navigator.geolocation.watchPosition(handlePosition, (err) => {
      const gpsEl = document.getElementById("status-text");
      if (gpsEl) gpsEl.innerText = "Errore GPS: " + err.message;
    }, {
      enableHighAccuracy: true,
      maximumAge: 1000,
      timeout: 10000
    });
    requestWakeLock();
  }
}
