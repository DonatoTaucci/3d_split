# 3D Split

Sito web per **importare un modello 3D, riconoscerne le parti e staccarle** dal resto del modello con un connettore, pronte per la stampa 3D.
Esempio: in una statuetta clicchi sui capelli → vengono riconosciuti e selezionati → premi *Separa parte* → ottieni due pezzi chiusi (capelli e corpo) con un perno e il relativo foro.

Tutto gira **nel browser**: i file non vengono caricati su nessun server.

## Funzioni

| | |
|---|---|
| **Formati in ingresso** | STL, 3MF, OBJ, PLY, GLB/GLTF, OFF, STEP/STP, IGES/IGS, BREP |
| **Riconoscimento automatico** | *Riconosci parti* divide il modello lungo pieghe concave e strozzature (testa, braccia, mani, ciocche, basamento…) |
| **Selezione con un clic** | 🎯 *Parte*: clicchi un punto e viene proposta la parte che lo contiene; i chip "Possibili parti" mostrano le alternative (più piccola / più grande) |
| **Più segmenti insieme** | In 🧩 *Segmento* ogni clic aggiunge un colore e un secondo clic lo toglie; nell'elenco puoi spuntare più segmenti e unirli (*Unisci spuntati*) |
| **Ridividi una zona** | ✂ accanto a un segmento, o *Ridividi solo la zona selezionata*: riconosce di nuovo le parti solo lì, con più dettaglio, senza toccare il resto (si annulla con Ctrl+Z) |
| **Vedere cosa si stacca** | *Mostra: Tutto / Attenua resto / Solo selezione* evidenzia esattamente la porzione che verrà esportata |
| **Altri strumenti** | ▱ Superficie (fino agli spigoli), 🖌 Pennello (aggiungi / Alt per togliere), ⬢ Corpo separato, Nuova/Aggiungi/Togli, Espandi/Riduci/Inverti |
| **AI (facoltativa)** | Con una chiave Gemini: *Riconosci e nomina le parti* (es. "capelli", "braccio destro") oppure scrivi cosa selezionare |
| **Taglio** | *Bordo naturale*: la giunzione segue esattamente il contorno della parte (superficie di chiusura curva). *Piano*: taglio piatto, regolabile con frecce/rotazione, stampabile senza supporti |
| **Connettori** | Perno tondo, perno quadrato (anti-rotazione), sedi per magneti, coda di rondine scorrevole (solo piano), con anteprima |
| **Misure automatiche** | Per ogni taglio calcola diametro, lunghezza e numero di connettori dalla forma della sezione e dallo spessore reale dei due pezzi (il foro non buca mai l'altro lato); per i magneti sceglie una misura standard (3×1 … 15×3 mm). Modificando a mano un valore si passa alle misure manuali |
| **Riparazione** | Chiude i buchi, rimuove i triangoli non-manifold, riorienta le normali |
| **Esportazione** | 3MF con tutte le parti (oggetti separati in Bambu Studio / PrusaSlicer / Cura), STL o OBJ in ZIP, STL singolo |

Ogni taglio produce pezzi **chiusi (watertight)**; i connettori sono calcolati con booleane robuste ([manifold-3d](https://github.com/elalish/manifold)).

## Come si usa

1. **Apri modello…** (o trascinalo nella finestra). Se il modello è alto pochi mm probabilmente è in un'altra unità: imposta l'altezza reale nel pannello *Modello* e premi *Scala*.
2. Se il pannello *Modello* dice che la mesh non è chiusa, premi **Ripara mesh** (serve per i connettori e il taglio a piano).
3. Clicca sulla parte da staccare. Se la proposta non è giusta, scegli un'altra dimensione tra i chip *Possibili parti* (passandoci sopra vedi l'anteprima), oppure correggi con Shift+clic (aggiungi), Alt+clic (togli) o il pennello.
   - Se la parte è fatta di più colori (es. un busto con veste, maniche e ciocche), premi *Riconosci parti*, passa a 🧩 *Segmento* e clicca i colori uno per uno.
   - Se un colore è troppo grande, premi ✂ accanto al segmento: solo quella zona viene ridivisa.
   - Con *Mostra → Solo selezione* vedi esattamente il pezzo che verrà staccato.
4. Scegli **Bordo naturale** o **Piano** e il connettore. Con *Misure automatiche* attivo, il riquadro arancione indica cosa è stato scelto (es. "2 perni Ø 3 mm, lunghezza 5 mm") e le sagome arancioni dove verranno messi.
5. **✂ Separa parte**. Puoi continuare a dividere qualsiasi pezzo, usare *Esplodi* per vederli separati, e infine **Esporta**.

Scorciatoie: `S` parte · `G` segmento · `U` superficie · `B` pennello · `C` corpo · `I` inverti · `+`/`-` espandi/riduci · `[`/`]` raggio pennello · `F` inquadra · `Esc` deseleziona · `Ctrl+Z`/`Ctrl+Y` annulla/ripeti.

### Consigli di stampa
- Tolleranza del perno: 0,15–0,3 mm per lato (dipende dalla stampante: fai una prova).
- I magneti più comuni sono 6×3 mm o 5×2 mm: imposta diametro e spessore del magnete, la tolleranza viene aggiunta automaticamente.
- Su figure piccole il collo può essere troppo sottile per un perno: in quel caso incolla i pezzi o taglia in un punto più spesso.

## Intelligenza artificiale (Gemini)

È **facoltativa**. Senza chiave tutto funziona con il riconoscimento geometrico; con la chiave Gemini il programma riconosce le parti per *significato* (capelli, viso, vestiti…), utile quando non c'è una piega netta tra le parti.

1. Crea una chiave su <https://aistudio.google.com/apikey>.
2. ⚙ *Impostazioni* → incolla la chiave → *Prova chiave* → *Salva*.

La chiave resta salvata **solo nel tuo browser** (localStorage) e viene inviata soltanto alle API di Google. Modello consigliato: `gemini-2.5-flash` (restituisce maschere di segmentazione).

Come funziona: il modello viene renderizzato da 6 angolazioni; per ogni vista viene salvato anche un "ID buffer" che dice quale triangolo occupa ogni pixel. Gemini restituisce le maschere delle parti, che vengono riportate sui triangoli, unite tra le viste e infine "agganciate" al bordo geometrico più vicino (l'AI decide *cosa* è una parte, la geometria decide *dove* passa il bordo).

## Sviluppo

Richiede Node.js 20+.

```bash
npm install
```

```bash
npm run dev
```

```bash
npm test
```

```bash
npm run build
```

`npm run build` crea la cartella `dist/`, un sito statico pubblicabile ovunque.

### Pubblicazione su GitHub Pages

Il workflow `.github/workflows/deploy.yml` esegue test e build a ogni push e pubblica il sito quando il push arriva sul **branch predefinito** del repository.
Per attivarlo una volta: *Settings → Pages → Build and deployment → Source: GitHub Actions*. Il sito sarà su `https://<utente>.github.io/3d_split/`.
Puoi anche avviarlo a mano da *Actions → Deploy su GitHub Pages → Run workflow*.

### Struttura

```
src/
  main.js            interfaccia e interazione
  viewer.js          scena three.js, picking (BVH), evidenziazione per triangolo
  geoClient.js       client del worker di geometria
  workers/geo.worker.js   booleane, anteprime e tagli (fuori dal thread della UI)
  core/
    meshdata.js      saldatura vertici, topologia, angoli diedri
    patches.js       concavità, "super-facce" e grafo delle zone
    segment.js       selezione intelligente, segmentazione automatica, rifinitura bordi, strumenti
    split.js         anelli di bordo, superfici di chiusura curve, riempimento buchi
    csg.js           taglio a piano e connettori con manifold-3d
    cutter.js        pipeline di taglio (piano/bordo naturale + connettori)
    repair.js        riparazione mesh
    demo.js          modello di esempio procedurale
  io/                importazione (3MF veloce, STEP via OpenCascade) ed esportazione
  ai/gemini.js       viste, prompt e proiezione delle maschere
tests/               test automatici (node:test)
```

### Algoritmi in breve
- **Concavità**: le parti di un oggetto si incontrano lungo pieghe concave ("minima rule"). Ogni coppia di triangoli adiacenti riceve un'affinità che crolla sulle pieghe concave, misurata sia sul singolo spigolo sia su scala più ampia (zone di ~30 triangoli), così funziona anche su sculture con pieghe arrotondate.
- **Clic → parte**: PageRank personalizzato sul grafo delle zone a partire dal punto cliccato, poi "sweep cut" che cerca il bordo con il miglior rapporto isoperimetrico (bordo corto o molto concavo rispetto all'area). I minimi locali diventano le alternative proposte.
- **Riconoscimento automatico**: bisezione spettrale ricorsiva (vettori di Fiedler) con lo stesso criterio di taglio.
- **Bordo preciso**: il confine tra zone viene rifinito triangolo per triangolo con un watershed minimax che lo fa scorrere sul fondo della piega.
- **Taglio a bordo naturale**: ogni anello di bordo viene chiuso con una membrana (anelli concentrici rilassati verso una superficie minima), condivisa dai due pezzi così combaciano perfettamente.

## Limiti noti
- Su mesh molto grandi (2 milioni di triangoli) caricamento e analisi richiedono alcuni secondi; il taglio a piano con connettori 10–20 s.
- Se due parti si fondono senza piega né strozzatura (es. capelli e viso scolpiti come un'unica superficie) la geometria da sola non può separarle con precisione: usa l'AI, il pennello o il taglio a piano.
- La coda di rondine è disponibile solo con il taglio a piano.
