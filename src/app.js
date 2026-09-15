// Powered by Angelo Martelli

pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.14.305/pdf.worker.min.js';

let route = [];
let currentStageIndex = 0;
let pdfDoc = null;

let totalKmTraveled = 0.0;
let tripKmTraveled = 0.0;
let lastCoords = null;
let watchId = null;
let wakeLock = null;

// INIZIALIZZAZIONE PAGINA
document.addEventListener("DOMContentLoaded", () => {
  if (document.body.classList.contains("page-dashboard")) {
    initDashboard();
  }
});

// INIZIALIZZA DASHBOARD (in src/dashboard.html)
function initDashboard() {
  const storedRoute = sessionStorage.getItem("roadbook_route");
  const storedPdfData = sessionStorage.getItem("roadbook_pdf_data");

  if (!storedRoute || !storedPdfData) {
    // Torna alla root se non sono presenti i dati
    window.location.href = "../index.html";
    return;
  }

  route = JSON.parse(storedRoute);
  
  // Ripristina il PDF memorizzato
  const pdfArray = new Uint8Array(JSON.parse(storedPdfData));
  pdfjsLib.getDocument(pdfArray).promise.then(doc => {
    pdfDoc = doc;
    updateStageDisplay();
    startGPS();
  }).catch(() => {
    window.location.href = "../index.html";
  });
}

// PARSING PDF (da index.html)
async function loadPDF(event) {
  const file = event.target.files[0];
  if (!file || file.type !== "application/pdf") return;

  const statusEl = document.getElementById("upload-status");
  statusEl.innerText = "Analisi Roadbook in corso...";

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
        
        // Salva i dati e naviga alla dashboard nella cartella src/
        sessionStorage.setItem("roadbook_route", JSON.stringify(extractedStages));
        sessionStorage.setItem("roadbook_pdf_data", JSON.stringify(Array.from(typedarray)));
        
        window.location.href = "src/dashboard.html";
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
  sessionStorage.removeItem("roadbook_route");
  sessionStorage.removeItem("roadbook_pdf_data");
  window.location.href = "../index.html";
}

// RENDERING COLONNA DIREZIONE DAL PDF
async function renderStageGraphic(stage) {
  const box = document.getElementById("current-direction-box");
  if (!box) return;
  box.innerHTML = "";

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

  const gpsEl = document.getElementById("status-text");
  if (gpsEl) {
    gpsEl.innerText = `GPS: ±${Math.round(accuracy)}m`;
    gpsEl.style.color = "#00e676";
  }

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

// Flag di sicurezza per evitare avanzamenti multipli incontrollati
let isAutoAdvancing = false;

function updateDisplays() {
  if (route.length === 0) return;

  const current = route[currentStageIndex];

  // Calcola i km rimanenti al target del parziale
  let remainingTrip = current.parziale - tripKmTraveled;

  // CONTROLLO AVANZAMENTO AUTOMATICO
  if (remainingTrip <= 0 && current.parziale > 0 && !isAutoAdvancing) {
    isAutoAdvancing = true;
    
    // Se c'è una nota successiva, passa automaticamente alla tappa seguente
    if (currentStageIndex < route.length - 1) {
      currentStageIndex++;
      tripKmTraveled = 0.0; // Reset del parziale per la nuova nota
      
      // Breve timeout per stabilizzare l'avanzamento ed evitare scatti doppi
      setTimeout(() => {
        updateStageDisplay();
        isAutoAdvancing = false;
      }, 500);
      return;
    } else {
      // Se è l'ultima nota del roadbook, blocca il contatore a 0.00
      remainingTrip = 0;
    }
  }

  if (remainingTrip < 0) remainingTrip = 0;

  // Aggiornamento interfaccia grafica
  const countdownEl = document.getElementById("trip-countdown");
  const totalEl = document.getElementById("total-traveled");

  if (countdownEl) countdownEl.innerText = remainingTrip.toFixed(2);
  if (totalEl) totalEl.innerText = totalKmTraveled.toFixed(2);
}

function nextStage() {
  if (currentStageIndex < route.length - 1) {
    currentStageIndex++;
    resetTrip();
  }
}

function resetTrip() {
  tripKmTraveled = 0.0;
  isAutoAdvancing = false;
  updateStageDisplay();
}

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
