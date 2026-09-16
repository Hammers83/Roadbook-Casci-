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

// SINTETIZZATORE SUONO DI AVVISO (Bip al raggiungimento dello 0)
function playAlertBeep() {
  try {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }

    if (audioCtx.state === 'suspended') {
      audioCtx.resume();
    }

    // Crea un oscillatore per generare un suono nitido
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();

    osc.type = "sine"; // Onda sinusoidale
    osc.frequency.setValueAtTime(880, audioCtx.currentTime); // Frequenza 880 Hz (Nota La/A5)
    
    // Inviluppo del volume (fade in breve e sfumatura rapida)
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

// CARICAMENTO UNIVERSELE (PDF, PNG, JPG, HEIC iPhone)
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

  // 2. Elaborazione Immagini
  if (file.type.startsWith("image/")) {
    if (statusEl) statusEl.innerText = "Elaborazione Immagine...";

    const reader = new FileReader();
    reader.onload = function(e) {
      const imageDataUrl = e.target.result;

      const imageStages = [
        {
          nota: 1,
          text: "ROADBOOK DA IMMAGINE",
          parziale: 0.00,
          totale: 0.00,
          isImage: true,
          imageData: imageDataUrl
        }
      ];

      sessionStorage.setItem("roadbook_route", JSON.stringify(imageStages));
      sessionStorage.removeItem("roadbook_pdf_data");
      
      window.location.href = "src/dashboard.html";
    };
    reader.readAsDataURL(file);
    return;
  }

  // 3. Elaborazione PDF
  if (file.type === "application/pdf") {
    loadPDF(file);
  } else {
    if (statusEl) statusEl.innerText = "Formato non supportato. Usa PDF, JPG, PNG o HEIC.";
  }
}

// PARSING PDF
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

          if (notaNum > 0 && notaNum < 150) {
            let noteText = "SEGUI STRADA";
            let valuesFound = [];
            let yPosition = entry.transform ? entry.transform[5] : 0;

            for (let j = Math.max(0, i - 4); j < Math.min(allItems.length, i + 6); j++) {
              let contextItem = allItems[j].text;
              
              if (/[A-Z]{3,}/.test(contextItem) && !contextItem.includes("AUTOSTRADA") && !contextItem.includes("DISTANZE")) {
                noteText = contextItem;
              }
              
              if (/^\d{1,2},\d{3}$/.test(contextItem)) {
                valuesFound.push(parseFloat(contextItem.replace(',', '.')));
              }
            }

            if (!extractedStages.some(s => s.nota === notaNum)) {
              let parziale = valuesFound.length > 0 ? valuesFound[0] : 0.0;
              let totale = valuesFound.length > 1 ? valuesFound[1] : parziale;

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

// RENDER GRAFICA NOTA
async function renderStageGraphic(stage) {
  const box = document.getElementById("current-direction-box");
  if (!box) return;
  box.innerHTML = "";

  if (stage.isImage && stage.imageData) {
    const img = document.createElement("img");
    img.src = stage.imageData;
    img.style.maxWidth = "100%";
    img.style.maxHeight = "100%";
    img.style.objectFit = "contain";
    box.appendChild(img);
    return;
  }

  if (!pdfDoc || !stage.page) {
    box.innerHTML = `<span style="font-size:2rem;">📍</span>`;
    return;
  }

  try {
    const page = await pdfDoc.getPage(stage.page);
    const viewport = page.getViewport({ scale: 2.0 });
    
    const fullCanvas = document.createElement("canvas");
    const fullCtx = fullCanvas.getContext("2d");
    fullCanvas.width = viewport.width;
    fullCanvas.height = viewport.height;

    await page.render({ canvasContext: fullCtx, viewport: viewport }).promise;

    const cropCanvas = document.createElement("canvas");
    const cropCtx = cropCanvas.getContext("2d");

    const cropX = viewport.width * 0.30; 
    const cropWidth = viewport.width * 0.40;
    const stageHeight = viewport.height / 8;
    
    let cropY = (viewport.height - (stage.yPos * 2.0)) - (stageHeight / 2);
    if (cropY < 0 || isNaN(cropY)) cropY = viewport.height * 0.2;

    cropCanvas.width = cropWidth;
    cropCanvas.height = stageHeight;

    cropCtx.drawImage(
      fullCanvas,
      cropX, cropY, cropWidth, stageHeight,
      0, 0, cropWidth, stageHeight
    );

    box.appendChild(cropCanvas);
  } catch (e) {
    box.innerHTML = `<span style="font-size:2rem;">🛠️</span>`;
  }
}

// AGGIORNA VISUALIZZAZIONE NOTA
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

  // CONTROLLO PARZIALE = 0 CON SUONO
  if (remainingTrip <= 0 && current.parziale > 0 && !isAutoAdvancing) {
    isAutoAdvancing = true;
    
    // Riproduce il bip acustico prima di cambiare nota
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

// WAKE LOCK E AVVIO GPS
async function requestWakeLock() {
  if ('wakeLock' in navigator) {
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      const lockEl = document.getElementById("wakelock-text");
      if (lockEl) {
        lockEl.innerText = "Schermo: Attivo 💡";
        lockEl.style.color = "#00e676";
      }
    } catch (err) {}
  }
}

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
