pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.14.305/pdf.worker.min.js';

let route = [];
let currentStageIndex = 0;
let pdfDoc = null;

let totalKmTraveled = 0.0;
let tripKmTraveled = 0.0;
let lastCoords = null;
let watchId = null;
let wakeLock = null;

// GESTIONE VISTE
function switchView(viewId) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById(viewId).classList.add('active');
}

// CARICAMENTO E PARSING PDF
async function loadPDF(event) {
  const file = event.target.files[0];
  if (!file || file.type !== "application/pdf") return;

  const statusEl = document.getElementById("upload-status");
  statusEl.innerText = "Caricamento in corso...";

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
          if (str.length > 0) {
            allItems.push({ text: str, page: i });
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
                page: entry.page
              });
            }
          }
        }
      }

      if (extractedStages.length > 0) {
        extractedStages.sort((a, b) => a.nota - b.nota);
        route = extractedStages;
        currentStageIndex = 0;
        
        switchView("view-dashboard");
        resetTrip();
        startGPS();
      } else {
        statusEl.innerText = "Nessuna nota riconosciuta nel PDF.";
      }
    } catch (err) {
      statusEl.innerText = "Errore lettura PDF: " + err.message;
    }
  };

  fileReader.readAsArrayBuffer(file);
}

function clearPDF() {
  document.getElementById("pdf-file-input").value = "";
  document.getElementById("upload-status").innerText = "";
  pdfDoc = null;
  route = [];
  currentStageIndex = 0;
  
  switchView("view-landing");
}

// RENDERING IMMAGINE TAPPA
async function renderStageGraphic(stage) {
  const box = document.getElementById("current-direction-box");
  box.innerHTML = "";

  if (!pdfDoc || !stage.page) {
    box.innerHTML = `<span style="font-size:2rem;">📍</span>`;
    return;
  }

  try {
    const page = await pdfDoc.getPage(stage.page);
    const viewport = page.getViewport({ scale: 1.5 });
    
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    canvas.width = viewport.width;
    canvas.height = viewport.height;

    await page.render({ canvasContext: ctx, viewport: viewport }).promise;
    box.appendChild(canvas);
  } catch (e) {
    box.innerHTML = `<span style="font-size:2rem;">⚠️</span>`;
  }
}

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

function nextStage() {
  if (currentStageIndex < route.length - 1) {
    currentStageIndex++;
    resetTrip();
  }
}

function prevStage() {
  if (currentStageIndex > 0) {
    currentStageIndex--;
    updateStageDisplay();
  }
}

// TRACCIAMENTO GPS E DISTANZA
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

function handlePosition(position) {
  const { latitude, longitude, accuracy } = position.coords;

  document.getElementById("status-text").innerText = `GPS: ±${Math.round(accuracy)}m`;
  document.getElementById("status-text").style.color = "#00e676";

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

function updateDisplays() {
  if (route.length === 0) return;

  const current = route[currentStageIndex];

  let remainingTrip = current.parziale - tripKmTraveled;
  if (remainingTrip < 0) remainingTrip = 0;

  document.getElementById("trip-countdown").innerText = remainingTrip.toFixed(2);
  document.getElementById("total-traveled").innerText = totalKmTraveled.toFixed(2);
}

function resetTrip() {
  tripKmTraveled = 0.0;
  updateStageDisplay();
}

async function requestWakeLock() {
  if ('wakeLock' in navigator) {
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      document.getElementById("wakelock-text").innerText = "Schermo: Attivo 💡";
      document.getElementById("wakelock-text").style.color = "#00e676";
    } catch (err) {}
  }
}

function startGPS() {
  if ("geolocation" in navigator && !watchId) {
    watchId = navigator.geolocation.watchPosition(handlePosition, (err) => {
      document.getElementById("status-text").innerText = "Errore GPS: " + err.message;
    }, {
      enableHighAccuracy: true,
      maximumAge: 1000,
      timeout: 10000
    });
    requestWakeLock();
  }
}
