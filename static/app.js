(function () {
  "use strict";

  const $ = (selector, root) => (root || document).querySelector(selector);
  const $$ = (selector, root) => Array.from((root || document).querySelectorAll(selector));
  const starterData = JSON.parse($("#starter-data").textContent || "{}");
  const PAGE_LABELS = {
    overview: "OVERVIEW",
    lab: "MOLECULE LAB",
    explorer: "COMPOUND EXPLORER",
    compare: "COMPARE",
    library: "STARTER LIBRARY",
    copilot: "RESEARCH NOTES"
  };
  const PROPERTY_LABELS = {
    "Molecular weight": "Molecular weight",
    "cLogP": "cLogP",
    "H-bond donors": "H-bond donors",
    "H-bond acceptors": "H-bond acceptors",
    "TPSA": "TPSA",
    "Rotatable bonds": "Rotatable bonds",
    "Rings": "Rings",
    "Heavy atoms": "Heavy atoms",
    "Formula": "Formula"
  };
  const state = {
    active: null,
    shortlist: readShortlist(),
    theme: readTheme(),
    admet: {},
    viewers: {},
    lastSearch: null,
    activePage: "overview"
  };

  function readTheme() {
    try { return localStorage.getItem("drugforge-theme") || "light"; } catch (_error) { return "light"; }
  }

  function writeStorage(key, value) {
    try { localStorage.setItem(key, value); return true; } catch (_error) { return false; }
  }

  function readShortlist() {
    try {
      const value = JSON.parse(localStorage.getItem("drugforge-shortlist") || "[]");
      return Array.isArray(value) ? value.filter((item) => item && item.smiles && item.properties) : [];
    } catch (_error) {
      return [];
    }
  }

  function saveShortlist() {
    writeStorage("drugforge-shortlist", JSON.stringify(state.shortlist));
    renderShortlist();
  }

  function safeText(value) {
    return String(value === null || value === undefined || value === "" ? "—" : value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function formatValue(value) {
    if (typeof value === "number") return Number.isInteger(value) ? String(value) : value.toFixed(2);
    return String(value === undefined || value === null ? "—" : value);
  }

  async function api(path, payload) {
    const response = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify(payload)
    });
    let data;
    try {
      data = await response.json();
    } catch (_error) {
      throw new Error("The server returned an unreadable response.");
    }
    if (!response.ok) throw new Error(data.error || "The request could not be completed.");
    return data;
  }

  function navigate(page) {
    if (!PAGE_LABELS[page]) return;
    state.activePage = page;
    $$(".page-section").forEach((node) => node.classList.toggle("active", node.id === "page-" + page));
    $$(".nav-item").forEach((node) => node.classList.toggle("active", node.dataset.page === page));
    $("#current-page-label").textContent = PAGE_LABELS[page];
    window.location.hash = page === "overview" ? "" : page;
    if (page === "lab" && state.active) requestAnimationFrame(() => resizeViewer("lab"));
    if (page === "explorer" && state.viewers.search) requestAnimationFrame(() => resizeViewer("search"));
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function setTheme(theme) {
    state.theme = theme === "dark" ? "dark" : "light";
    document.documentElement.dataset.theme = state.theme;
    writeStorage("drugforge-theme", state.theme);
    $("#theme-label").textContent = state.theme === "dark" ? "Light mode" : "Dark mode";
    $("#theme-icon").textContent = state.theme === "dark" ? "☼" : "☾";
    $("#theme-toggle").setAttribute("aria-label", state.theme === "dark" ? "Switch to light mode" : "Switch to dark mode");
    Object.values(state.viewers).forEach((viewer) => {
      try {
        viewer.setBackgroundColor(state.theme === "dark" ? "#0e151d" : "#f4f6f7");
        viewer.render();
      } catch (_error) {}
    });
  }

  function showError(id, message) {
    const node = $("#" + id);
    node.textContent = message;
    node.classList.add("visible");
  }

  function clearError(id) {
    const node = $("#" + id);
    node.textContent = "";
    node.classList.remove("visible");
  }

  function toast(message, isError) {
    const node = document.createElement("div");
    node.className = "toast" + (isError ? " error" : "");
    node.textContent = message;
    $("#toast-region").appendChild(node);
    window.setTimeout(() => node.remove(), 3200);
  }

  function renderViewer(molecule, elementId, key) {
    const container = document.getElementById(elementId);
    if (!container) return;
    const molblock = molecule && molecule.molblock;
    if (!molblock) {
      container.innerHTML = '<div class="empty-state"><div class="empty-symbol">⌬</div><strong>3D conformer unavailable</strong><span>Try a different structure or stereochemical form.</span></div>';
      return;
    }
    if (!window.$3Dmol || typeof window.$3Dmol.createViewer !== "function") {
      container.innerHTML = '<div class="empty-state"><div class="empty-symbol">⌬</div><strong>3D viewer could not load</strong><span>Check your internet connection and refresh the page.</span></div>';
      return;
    }

    try {
      if (state.viewers[key] && typeof state.viewers[key].clear === "function") state.viewers[key].clear();
      container.innerHTML = "";
      const viewer = window.$3Dmol.createViewer(container, {
        backgroundColor: state.theme === "dark" ? "#0e151d" : "#f4f6f7",
        antialias: true,
        preserveDrawingBuffer: true
      });
      viewer.addModel(molblock, "sdf");
      viewer.setStyle({}, {
        stick: { radius: 0.13, colorscheme: "Jmol" },
        sphere: { scale: 0.22, colorscheme: "Jmol" }
      });
      viewer.zoomTo();
      viewer.render();
      state.viewers[key] = viewer;
      const resize = () => {
        const active = state.viewers[key];
        if (!active) return;
        try { active.resize(); active.render(); } catch (_error) {}
      };
      if (window.ResizeObserver) {
        const observer = new ResizeObserver(resize);
        observer.observe(container);
        container._drugforgeResizeObserver = observer;
      }
      requestAnimationFrame(resize);
    } catch (error) {
      console.error("3D rendering failed", error);
      container.innerHTML = '<div class="empty-state"><div class="empty-symbol">⌬</div><strong>Could not display this conformer</strong><span>The molecule was analyzed, but its 3D model could not be drawn.</span></div>';
    }
  }

  function resizeViewer(key) {
    const viewer = state.viewers[key];
    if (!viewer) return;
    try { viewer.resize(); viewer.render(); } catch (_error) {}
  }

  function renderProfile(molecule) {
    const grid = $("#property-grid");
    grid.innerHTML = Object.entries(molecule.properties || {}).map(([label, value]) =>
      '<div class="property-cell"><span>' + safeText(PROPERTY_LABELS[label] || label) +
      '</span><strong>' + safeText(formatValue(value)) + '</strong></div>'
    ).join("");

    const checks = molecule.checks || {};
    $("#screening-score").textContent = String(molecule.score) + "%";
    $("#screening-checks").innerHTML = Object.entries(checks).map(([label, passed]) =>
      '<div class="check-row ' + (passed ? "" : "fail") + '"><span>' + safeText(label) +
      '</span><span>' + (passed ? "WITHIN THRESHOLD" : "OUTSIDE THRESHOLD") + '</span></div>'
    ).join("");

    $("#structure-title").textContent = molecule.name || "Molecule structure";
    $("#structure-formula").textContent = molecule.properties.Formula || "—";
    $("#structure-atoms").textContent = String(molecule.properties["Heavy atoms"] || "—") + " HEAVY ATOMS";
    $("#save-candidate").disabled = false;
    $("#download-sdf").disabled = false;
    renderViewer(molecule, "molecule-viewer", "lab");
    renderAdmetPanel(molecule, "lab-admet-results", "run-lab-admet");
    renderOverviewActive(molecule);
    renderCopilotContext();
  }

  function renderAdmetPanel(molecule, panelId, buttonId) {
    const panel = document.getElementById(panelId);
    const button = document.getElementById(buttonId);
    if (!panel) return;
    if (!molecule) {
      if (button) button.disabled = true;
      panel.innerHTML = '<div class="property-placeholder">Analyze a molecule, then request its ADMET profile.</div>';
      return;
    }

    const item = state.admet[molecule.smiles];
    if (button) {
      button.disabled = Boolean(item && ["submitting", "polling"].includes(item.status));
      button.innerHTML = item && item.status === "pending"
        ? 'Check ADMET status <span>↻</span>'
        : item && item.status === "complete"
          ? 'Run ADMET again <span>→</span>'
          : item && item.status === "error"
            ? 'Retry ADMET prediction <span>↻</span>'
            : item && ["submitting", "polling"].includes(item.status)
              ? '<span class="spinner"></span> ' + (item.status === "submitting" ? "Submitting molecule…" : "Checking Deep-PK…")
              : 'Run external ADMET prediction <span>→</span>';
    }

    if (!item) {
      panel.innerHTML = '<div class="property-placeholder">No ADMET results yet. Run the external prediction to request them.</div>';
    } else if (item.status === "submitting") {
      panel.innerHTML = '<div class="admet-state"><span class="loading-ring"></span><strong>Submitting structure to Deep-PK</strong><span>This may take a few seconds.</span></div>';
    } else if (item.status === "polling") {
      panel.innerHTML = '<div class="admet-state"><span class="loading-ring"></span><strong>Prediction job is processing</strong><span>Deep-PK is calculating the profile. This panel will update automatically.</span></div>';
    } else if (item.status === "pending") {
      panel.innerHTML = '<div class="admet-state"><strong>Prediction is still queued</strong><span>' +
        safeText(item.error || "Use Check ADMET status to look for the result again.") + '</span></div>';
    } else if (item.status === "error") {
      panel.innerHTML = '<div class="server-error">' + safeText(item.error || "The ADMET request could not be completed.") + '</div>';
    } else {
      panel.innerHTML = renderAdmetRecord(item.record);
    }
  }

  function refreshAdmetViews(molecule) {
    if (state.active && state.active.smiles === molecule.smiles) {
      renderAdmetPanel(state.active, "lab-admet-results", "run-lab-admet");
    }
    if (state.lastSearch && state.lastSearch.molecule &&
        state.lastSearch.molecule.smiles === molecule.smiles) {
      renderAdmetPanel(state.lastSearch.molecule, "search-admet-results", "run-search-admet");
    }
  }

  function admetCategoryAndEndpoint(suffix) {
    const categories = [
      ["general_properties_", "General properties"],
      ["absorption_", "Absorption"],
      ["distribution_", "Distribution"],
      ["metabolism_", "Metabolism"],
      ["excretion_", "Excretion"],
      ["toxicity_", "Toxicity"]
    ];
    for (const [prefix, label] of categories) {
      if (suffix.startsWith(prefix)) return { category: label, endpoint: suffix.slice(prefix.length) };
    }
    return { category: "Other", endpoint: suffix };
  }

  function humanizeAdmetEndpoint(endpoint) {
    const known = {
      caco_2: "Caco-2 permeability",
      f20: "Oral bioavailability (F20)",
      f30: "Oral bioavailability (F30)",
      hia: "Human intestinal absorption",
      log_s: "Water solubility (logS)",
      mdck_permeability: "MDCK permeability",
      ob: "Oral bioavailability",
      pgp_inhibitor: "P-glycoprotein inhibitor",
      pgp_substrate: "P-glycoprotein substrate",
      bbb: "Blood-brain barrier permeability",
      human_clinical_drugs_vdss: "Volume of distribution (VDss)",
      ppb: "Plasma protein binding",
      clearance: "Total clearance",
      oct2: "Renal OCT2 transporter",
      t05: "Elimination half-life",
      hepatotoxicity: "Hepatotoxicity",
      ames: "AMES mutagenicity",
      skin_sensitisation: "Skin sensitisation",
      skin_sensitization: "Skin sensitisation"
    };
    if (known[endpoint]) return known[endpoint];
    return endpoint.split("_").map((word) => {
      if (/^cyp/i.test(word)) return word.toUpperCase();
      if (/^oatp/i.test(word)) return word.toUpperCase();
      if (word === "bbb") return "BBB";
      if (word === "pgp") return "P-gp";
      if (word === "oct2") return "OCT2";
      if (word === "ppb") return "PPB";
      return word.charAt(0).toUpperCase() + word.slice(1);
    }).join(" ");
  }

  function admetValue(value) {
    if (typeof value === "number" && Number.isFinite(value)) return String(Number(value.toFixed(3)));
    return String(value === undefined || value === null || value === "" || value === "-" ? "—" : value);
  }

  function renderAdmetRecord(record) {
    const keys = Object.keys(record || {}).filter((key) => key.startsWith("Predictions_"));
    if (!keys.length) return '<div class="server-error">Deep-PK returned no prediction endpoints for this molecule.</div>';
    const groups = {};
    keys.forEach((key) => {
      const suffix = key.slice("Predictions_".length);
      const info = admetCategoryAndEndpoint(suffix);
      if (!groups[info.category]) groups[info.category] = [];
      groups[info.category].push({
        suffix: suffix,
        endpoint: humanizeAdmetEndpoint(info.endpoint),
        prediction: record[key],
        probability: record["Probability_" + suffix],
        interpretation: record["Interpretation_" + suffix]
      });
    });
    const order = ["Absorption", "Distribution", "Metabolism", "Excretion", "Toxicity", "General properties", "Other"];
    return '<div class="admet-summary"><span>' + keys.length +
      ' MODEL OUTPUTS</span><span>Provider: Deep-PK · prediction only</span></div>' +
      order.filter((category) => groups[category]).map((category) => {
        const rows = groups[category].map((item) =>
          '<tr><td title="' + safeText(item.suffix) + '">' + safeText(item.endpoint) + '</td><td>' +
          safeText(admetValue(item.prediction)) + '</td><td>' +
          safeText(admetValue(item.probability)) + '</td><td>' +
          safeText(item.interpretation === "None" ? "—" : admetValue(item.interpretation)) + '</td></tr>'
        ).join("");
        return '<details class="admet-group"' + (category === "Absorption" ? " open" : "") +
          '><summary><span>' + safeText(category) + '</span><span>' + groups[category].length +
          ' endpoints</span></summary><div class="admet-table-wrap"><table class="admet-table"><thead><tr>' +
          '<th>Endpoint</th><th>Predicted value</th><th>Probability (0–1)</th><th>Model interpretation</th>' +
          '</tr></thead><tbody>' + rows + '</tbody></table></div></details>';
      }).join("") +
      '<p class="small-note">Probability values are returned by the provider and are not necessarily calibrated. Review the <a href="https://biosig.lab.uq.edu.au/deeppk/theory" target="_blank" rel="noopener noreferrer">Deep-PK model theory</a> before interpreting endpoints.</p>';
  }

  async function runAdmet(scope) {
    const molecule = scope === "search"
      ? (state.lastSearch && state.lastSearch.molecule)
      : state.active;
    if (!molecule) {
      toast("Analyze or find a structure before requesting ADMET.", true);
      return;
    }
    const key = molecule.smiles;
    let item = state.admet[key];
    if (item && item.status === "complete") {
      // A deliberate second click starts a fresh provider job instead of
      // silently leaving the already cached result in place.
      delete state.admet[key];
      item = null;
    }
    try {
      if (!item || !item.jobId) {
        item = { status: "submitting", record: null, jobId: null, error: null };
        state.admet[key] = item;
        refreshAdmetViews(molecule);
        const submitted = await api("/api/admet/submit", { smiles: molecule.smiles });
        item.jobId = submitted.job_id;
      }
      item.status = "polling";
      item.error = null;
      refreshAdmetViews(molecule);
      for (let attempt = 0; attempt < 45; attempt += 1) {
        const status = await api("/api/admet/status", { job_id: item.jobId });
        if (status.status === "complete" && status.record) {
          item.status = "complete";
          item.record = status.record;
          item.error = null;
          refreshAdmetViews(molecule);
          toast("Deep-PK ADMET profile received.");
          return;
        }
        if (status.status === "failed") throw new Error(status.error || "Deep-PK could not process this molecule.");
        if (attempt < 44) await new Promise((resolve) => window.setTimeout(resolve, 2000));
      }
      item.status = "pending";
      item.error = "The job is taking longer than expected. Its ID is saved in this browser session; check again in a moment.";
      refreshAdmetViews(molecule);
    } catch (error) {
      item = state.admet[key] || { jobId: null };
      item.status = item.jobId ? "pending" : "error";
      item.error = error.message;
      state.admet[key] = item;
      refreshAdmetViews(molecule);
    }
  }

  function renderOverviewActive(molecule) {
    const holder = $("#overview-active");
    if (!molecule) {
      holder.innerHTML = '<div class="empty-state compact"><div class="empty-symbol">⌬</div><strong>No molecule analyzed yet</strong><span>Start in Molecule Lab or open a library example.</span></div>';
      return;
    }
    holder.innerHTML = '<div class="active-preview"><div class="preview-orb">⌬</div><div class="preview-copy"><strong>' +
      safeText(molecule.name) + '</strong><span>' + safeText(molecule.properties.Formula) +
      ' · ' + safeText(molecule.properties["Molecular weight"]) + ' Da</span></div><div class="preview-score">' +
      safeText(molecule.score) + '%</div></div>';
  }

  function openMolecule(molecule) {
    state.active = molecule;
    $("#molecule-name").value = molecule.name || "";
    $("#molecule-smiles").value = molecule.smiles || "";
    renderProfile(molecule);
    navigate("lab");
  }

  async function analyzeCurrent() {
    const button = $("#analyze-button");
    const smiles = $("#molecule-smiles").value.trim();
    const name = $("#molecule-name").value.trim();
    clearError("lab-error");
    if (!smiles) {
      showError("lab-error", "Add a SMILES string first. Search for a compound name in Compound Explorer.");
      return;
    }
    button.disabled = true;
    button.innerHTML = '<span class="spinner"></span> Generating 3D conformer…';
    try {
      const molecule = await api("/api/analyze", { name: name, smiles: smiles, source: "Manual entry" });
      state.active = molecule;
      renderProfile(molecule);
      toast("Molecular profile generated.");
    } catch (error) {
      showError("lab-error", error.message);
    } finally {
      button.disabled = false;
      button.innerHTML = "Analyze structure <span>→</span>";
    }
  }

  function shortlistMolecule(molecule) {
    const duplicate = state.shortlist.some((item) => item.smiles === molecule.smiles);
    if (duplicate) {
      toast("This molecule is already in your shortlist.");
      return;
    }
    const saved = {
      name: molecule.name,
      smiles: molecule.smiles,
      source: molecule.source,
      created: molecule.created,
      properties: molecule.properties,
      checks: molecule.checks,
      score: molecule.score
    };
    state.shortlist.push(saved);
    saveShortlist();
    toast("Saved to your browser shortlist.");
  }

  async function openSavedMolecule(item) {
    navigate("lab");
    $("#molecule-name").value = item.name;
    $("#molecule-smiles").value = item.smiles;
    $("#lab-error").textContent = "";
    try {
      const full = await api("/api/analyze", { name: item.name, smiles: item.smiles, source: item.source || "Saved shortlist" });
      state.active = full;
      renderProfile(full);
    } catch (error) {
      showError("lab-error", error.message);
    }
  }

  function downloadSdf() {
    if (!state.active || !state.active.molblock) return;
    const blob = new Blob([state.active.molblock + "\n$$$$\n"], { type: "chemical/x-mdl-sdfile" });
    const link = document.createElement("a");
    const url = URL.createObjectURL(blob);
    link.href = url;
    link.download = (state.active.name || "molecule").replace(/[^a-z0-9_-]+/gi, "_") + ".sdf";
    link.click();
    URL.revokeObjectURL(url);
  }

  function renderShortlist() {
    const count = state.shortlist.length;
    $("#nav-shortlist-count").textContent = String(count);
    $("#overview-shortlist-count").textContent = String(count).padStart(2, "0");
    $("#compare-count-tag").textContent = count + (count === 1 ? " SAVED" : " SAVED");
    const root = $("#compare-content");
    if (!count) {
      root.innerHTML = '<div class="empty-panel"><div class="empty-symbol">▤</div><h2>Your shortlist is ready</h2><p>Analyze a molecule or open a starter compound, then save it here for comparison.</p><button class="button button-primary" data-go="lab">Open molecule lab <span>→</span></button></div>';
      return;
    }
    const rows = state.shortlist.map((item, index) => {
      const p = item.properties || {};
      return '<tr><td><button class="compare-name" data-open-saved="' + index + '">' + safeText(item.name) +
        '</button><div class="result-subtitle">' + safeText(p.Formula || item.source || "") + '</div></td>' +
        '<td>' + safeText(p["Molecular weight"]) + '</td><td>' + safeText(p.cLogP) + '</td>' +
        '<td>' + safeText(p["H-bond donors"]) + ' / ' + safeText(p["H-bond acceptors"]) + '</td>' +
        '<td>' + safeText(p.TPSA) + '</td><td><span class="score-meter">' + safeText(item.score) +
        '% <i><b style="width:' + Math.max(0, Math.min(100, Number(item.score) || 0)) + '%"></b></i></span></td>' +
        '<td><button class="remove-candidate" data-remove="' + index + '" aria-label="Remove ' + safeText(item.name) +
        '" title="Remove candidate">×</button></td></tr>';
    }).join("");
    root.innerHTML = '<div class="compare-toolbar"><span>Computed descriptors · values are not activity predictions</span><button class="text-button" id="clear-shortlist">Clear shortlist</button></div>' +
      '<div class="compare-table-wrap"><table class="compare-table"><thead><tr><th>Candidate</th><th>MW / Da</th><th>cLogP</th><th>HBD / HBA</th><th>TPSA</th><th>Threshold screen</th><th></th></tr></thead><tbody>' +
      rows + '</tbody></table></div><p class="compare-footnote">The threshold screen counts five broad property checks only. It does not estimate potency, selectivity, safety, or binding. Shortlist data is stored in local browser storage.</p>';
  }

  function renderStarters() {
    const names = Object.keys(starterData);
    $("#lab-starters").innerHTML = names.map((name) =>
      '<button class="starter-chip" data-starter="' + safeText(name) + '">' + safeText(name) + '</button>'
    ).join("");
    $("#library-grid").innerHTML = names.map((name) => {
      const item = starterData[name];
      return '<article class="library-card"><div class="library-card-top"><span class="library-glyph">⌬</span><span class="library-card-meta">STARTER</span></div><h3>' +
        safeText(name) + '</h3><p>' + safeText(item.note) + '</p><button class="button button-secondary" data-starter="' +
        safeText(name) + '">Explore structure <span>→</span></button></article>';
    }).join("");
  }

  async function loadStarter(name) {
    const starter = starterData[name];
    if (!starter) return;
    navigate("lab");
    $("#molecule-name").value = name;
    $("#molecule-smiles").value = starter.smiles;
    clearError("lab-error");
    $("#analyze-button").disabled = true;
    $("#analyze-button").textContent = "Generating conformer…";
    try {
      const molecule = await api("/api/analyze", { name: name, smiles: starter.smiles, source: "Starter library" });
      state.active = molecule;
      renderProfile(molecule);
    } catch (error) {
      showError("lab-error", error.message);
    } finally {
      $("#analyze-button").disabled = false;
      $("#analyze-button").innerHTML = "Analyze structure <span>→</span>";
    }
  }

  function recordCard(pubchem, chembl) {
    const props = pubchem && pubchem.properties;
    let cards = "";
    if (props) {
      const cid = props.CID;
      cards += '<article class="db-card"><div class="db-card-top"><strong>PUBCHEM</strong><span>CID ' + safeText(cid) + '</span></div>' +
        '<p><b>Formula</b> · ' + safeText(props.MolecularFormula) + '　 <b>MW</b> · ' + safeText(props.MolecularWeight) + ' Da</p>' +
        '<p><b>XLogP</b> · ' + safeText(props.XLogP) + '</p><p class="result-subtitle">' + safeText(props.IUPACName) + '</p>' +
        '<a class="result-link" target="_blank" rel="noopener noreferrer" href="https://pubchem.ncbi.nlm.nih.gov/compound/' +
        encodeURIComponent(String(cid)) + '">Open PubChem record ↗</a></article>';
    } else {
      const status = pubchem && pubchem.status === "unavailable" ? safeText(pubchem.error) : "No matching PubChem record was returned.";
      cards += '<article class="db-card"><div class="db-card-top"><strong>PUBCHEM</strong><span>' +
        (pubchem && pubchem.status === "unavailable" ? "UNAVAILABLE" : "NO MATCH") + '</span></div><p>' + status + '</p></article>';
    }

    const molecules = chembl && chembl.molecules ? chembl.molecules.slice(0, 3) : [];
    if (molecules.length) {
      cards += '<article class="db-card"><div class="db-card-top"><strong>CHEMBL</strong><span>' + molecules.length + ' MATCHES</span></div><div class="compound-list">' +
        molecules.map((item) => {
          const id = String(item.molecule_chembl_id || "");
          return '<div class="chembl-item"><div><strong>' + safeText(item.pref_name || "Unnamed molecule") +
            '</strong><span>' + safeText(id) + ' · <a class="result-link" href="https://www.ebi.ac.uk/chembl/web_components/explore/compound/' +
            encodeURIComponent(id) + '" target="_blank" rel="noopener noreferrer">Open record ↗</a></span></div><button data-activities="' +
            safeText(id) + '">Load activity</button></div>';
        }).join("") + '</div></article>';
    } else {
      const status = chembl && chembl.status === "unavailable" ? safeText(chembl.error) : "No matching ChEMBL molecule was returned.";
      cards += '<article class="db-card"><div class="db-card-top"><strong>CHEMBL</strong><span>' +
        (chembl && chembl.status === "unavailable" ? "UNAVAILABLE" : "NO MATCH") + '</span></div><p>' + status + '</p></article>';
    }
    return cards;
  }

  function renderSearchResults(result) {
    const root = $("#search-results");
    state.lastSearch = result;
    const found = (result.pubchem && result.pubchem.properties) || (result.chembl && result.chembl.molecules && result.chembl.molecules.length);
    if (!found) {
      const serviceErrors = [
        result.pubchem && result.pubchem.status === "unavailable" ? result.pubchem.error : "",
        result.chembl && result.chembl.status === "unavailable" ? result.chembl.error : ""
      ].filter(Boolean).join(" ");
      root.innerHTML = '<div class="empty-panel"><div class="empty-symbol">⌕</div><h2>' +
        (serviceErrors ? "Public database temporarily unavailable" : "No matching record found") +
        '</h2><p>' + safeText(serviceErrors || "Try a common name, a synonym, or a valid SMILES string.") +
        '</p><div class="api-status">Input interpreted as ' + safeText(result.query_type) +
        ' · Query: ' + safeText(result.query) + '</div></div>';
      return;
    }
    const molecule = result.molecule;
    const name = molecule ? molecule.name : (result.pubchem.properties && result.pubchem.properties.Title) ||
      (result.chembl.molecules[0] && result.chembl.molecules[0].pref_name) || result.query;
    const right = molecule
      ? '<article class="panel result-card"><div class="panel-kicker">3D STRUCTURE PREVIEW</div><h2>' + safeText(name) +
        '</h2><p class="result-subtitle">' + safeText(molecule.properties.Formula) + ' · ' +
        safeText(molecule.properties["Molecular weight"]) + ' Da · RDKit conformer</p><div class="viewer-canvas search-viewer" id="search-viewer"><div class="empty-state"><div class="empty-symbol">⌬</div><strong>Building 3D conformer…</strong></div></div><div class="input-actions"><button class="button button-primary" id="open-search-molecule">Open in Molecule Lab <span>→</span></button><button class="button button-secondary" id="save-search-molecule">＋ Save</button></div>' +
        '<div class="search-admet-block"><div class="panel-kicker">PREDICTED ADMET</div><p class="admet-disclosure">Optional external model: running sends this SMILES to Deep-PK. Its privacy notice says submitted data are deleted 7 days after results are ready. Do not send confidential structures. <a href="https://biosig.lab.uq.edu.au/deeppk/privacy" target="_blank" rel="noopener noreferrer">Privacy details ↗</a></p><button class="button button-secondary admet-run" id="run-search-admet" data-admet-scope="search">Run ADMET prediction <span>→</span></button><div class="admet-results" id="search-admet-results"></div></div>' +
        (result.analysis_error ? '<div class="server-error">' + safeText(result.analysis_error) + '</div>' : '') + '</article>'
      : '<article class="panel result-card"><div class="panel-kicker">STRUCTURE</div><h2>' + safeText(name) +
        '</h2><p class="card-copy">A compound record was found, but no usable canonical SMILES was available for local 3D analysis.</p></article>';
    root.innerHTML = '<div class="result-grid"><article class="panel result-card"><div class="panel-kicker">DATABASE MATCHES</div><h2>' +
      safeText(name) + '</h2><p class="result-subtitle">Query interpreted as ' + safeText(result.query_type) + ' · ' +
      safeText(result.query) + '</p><div class="db-cards">' + recordCard(result.pubchem, result.chembl) +
      '</div><div id="activity-panel" class="activities"></div></article>' + right + '</div>';
    if (molecule) {
      renderViewer(molecule, "search-viewer", "search");
      renderAdmetPanel(molecule, "search-admet-results", "run-search-admet");
      $("#open-search-molecule").addEventListener("click", () => openMolecule(molecule));
      $("#save-search-molecule").addEventListener("click", () => shortlistMolecule(molecule));
    }
  }

  async function searchCompounds() {
    const query = $("#compound-query").value.trim();
    clearError("search-error");
    if (!query) {
      showError("search-error", "Enter a compound name or SMILES string to search.");
      return;
    }
    const button = $("#search-button");
    const previousLabel = button.innerHTML;
    button.disabled = true;
    button.innerHTML = '<span class="spinner"></span> Searching…';
    $("#search-results").innerHTML = '<div class="empty-panel"><div class="loading-ring"></div><h2>Searching public records</h2><p>Contacting PubChem and ChEMBL in parallel…</p></div>';
    try {
      const result = await api("/api/search", { query: query, query_type: $("#query-type").value });
      renderSearchResults(result);
    } catch (error) {
      showError("search-error", error.message);
      $("#search-results").innerHTML = '<div class="server-error">' + safeText(error.message) + '</div>';
    } finally {
      button.disabled = false;
      button.innerHTML = previousLabel;
    }
  }

  async function loadActivities(chemblId, button) {
    const panel = $("#activity-panel");
    if (!panel) return;
    panel.innerHTML = '<div class="api-status">Loading selected ChEMBL activity records…</div>';
    if (button) button.disabled = true;
    try {
      const data = await api("/api/activities", { chembl_id: chemblId });
      if (!data.activities || !data.activities.length) {
        panel.innerHTML = '<h3>Bioactivity evidence · ' + safeText(chemblId) + '</h3><p class="api-status">No qualifying IC50, EC50, Ki, Kd, or potency records were returned.</p>';
        return;
      }
      const rows = data.activities.map((item) => {
        const target = item.target_pref_name || item.target_chembl_id || "Not assigned";
        const potency = [item.standard_relation, item.standard_value, item.standard_units].filter(Boolean).join(" ");
        const pchembl = item.pchembl_value || "—";
        const year = item.document_year || "";
        const ref = item.document_chembl_id || "";
        const source = ref ? '<a class="result-link" href="https://www.ebi.ac.uk/chembl/web_components/explore/document/' + encodeURIComponent(ref) +
          '" target="_blank" rel="noopener noreferrer">' + safeText(ref) + (year ? " · " + safeText(year) : "") + ' ↗</a>' : safeText(year || "—");
        return '<tr><td>' + safeText(target) + '<br><span class="muted-copy">' + safeText(item.target_organism || "") +
          '</span></td><td>' + safeText(item.standard_type) + '</td><td>' + safeText(potency) +
          '</td><td>' + safeText(pchembl) + '</td><td>' + source + '</td></tr>';
      }).join("");
      panel.innerHTML = '<h3>Selected bioactivity records · ' + safeText(chemblId) + '</h3><div class="activity-table-wrap"><table class="activity-table"><thead><tr><th>Target / organism</th><th>Assay</th><th>Reported value</th><th>pChEMBL</th><th>Source</th></tr></thead><tbody>' +
        rows + '</tbody></table></div><p class="small-note">' + safeText(data.total || data.activities.length) +
        ' matching record(s); showing up to 20. Assay values depend on assay design, target construct, organism, relation, and units.</p>';
    } catch (error) {
      panel.innerHTML = '<div class="server-error">' + safeText(error.message) + '</div>';
    } finally {
      if (button) button.disabled = false;
    }
  }

  function buildResearchNote(prompt) {
    const text = prompt.toLowerCase();
    const active = state.active;
    const items = state.shortlist;
    if ((text.includes("shortlist") || text.includes("compare")) && items.length < 2) {
      return "The current shortlist contains " + items.length + " molecule" + (items.length === 1 ? "" : "s") +
        ". Add at least one more, then open Compare to review the descriptors side by side. The score counts five broad property thresholds; it is not evidence of potency, selectivity, safety, or binding.";
    }
    if (text.includes("shortlist") || text.includes("compare")) {
      const names = items.map((item) => item.name + " (" + item.score + "%)").join(", ");
      return "The current shortlist contains " + items.length + " candidates: " + names +
        ". Open Compare for the descriptor table. The threshold score is a simple property screen and should not be interpreted as activity or developability.";
    }
    if (text.includes("lipinski") || text.includes("screen") || text.includes("threshold")) {
      return "The screen checks molecular weight ≤ 500 Da, cLogP ≤ 5, hydrogen-bond donors ≤ 5, hydrogen-bond acceptors ≤ 10, and TPSA ≤ 140 Å². Each passing threshold contributes equally to the displayed percentage. These broad guidelines do not predict target engagement, potency, pharmacokinetics, safety, or clinical outcomes.";
    }
    if (text.includes("binding") || text.includes("potency") || text.includes("effective") || text.includes("safe")) {
      return "This workspace does not calculate binding affinity, potency, safety, or therapeutic efficacy. Use Compound Explorer to inspect available ChEMBL assay records, and review each record's assay conditions and primary literature before drawing conclusions.";
    }
    if (!active) {
      return "There is no active molecule in Molecule Lab yet. Analyze a SMILES string or open a starter molecule first. For live public compound records, use Compound Explorer.";
    }
    if (text.includes("summar") || text.includes("profile") || text.includes("molecule") || text.includes("describe")) {
      const p = active.properties;
      const passed = Object.values(active.checks || {}).filter(Boolean).length;
      return active.name + " has formula " + p.Formula + ", molecular weight " + p["Molecular weight"] +
        " Da, cLogP " + p.cLogP + ", " + p["H-bond donors"] + " hydrogen-bond donor(s), " +
        p["H-bond acceptors"] + " acceptor(s), and TPSA " + p.TPSA + " Å². It meets " + passed +
        " of 5 broad property thresholds (" + active.score + "%). These descriptors do not establish biological activity or safety.";
    }
    return "I can summarize the active molecule profile, explain the Lipinski-style property screen, or describe the saved shortlist. For literature-grounded conclusions, review primary sources linked from PubChem or ChEMBL.";
  }

  function appendMessage(text, isUser) {
    const history = $("#chat-history");
    const item = document.createElement("div");
    item.className = isUser ? "user-message" : "assistant-message";
    if (!isUser) item.innerHTML = '<span class="message-avatar">DF</span>';
    const bubble = document.createElement("div");
    if (!isUser) bubble.innerHTML = "<small>DRUGFORGE NOTES</small>";
    const paragraph = document.createElement("p");
    paragraph.textContent = text;
    bubble.appendChild(paragraph);
    item.appendChild(bubble);
    history.appendChild(item);
    history.scrollTop = history.scrollHeight;
  }

  function submitNote(prompt) {
    const text = prompt.trim();
    if (!text) return;
    appendMessage(text, true);
    appendMessage(buildResearchNote(text), false);
    $("#copilot-input").value = "";
  }

  function renderCopilotContext() {
    if (!state.active) {
      $("#copilot-context-title").textContent = "No molecule selected";
      $("#copilot-context-copy").textContent = "Analyze a structure to make it available for local notes.";
      return;
    }
    $("#copilot-context-title").textContent = state.active.name + " · " + state.active.properties.Formula;
    $("#copilot-context-copy").textContent = state.active.properties["Molecular weight"] +
      " Da · cLogP " + state.active.properties.cLogP + " · " + state.active.score + "% threshold screen.";
  }

  document.addEventListener("click", (event) => {
    const pageButton = event.target.closest("[data-page]");
    if (pageButton) navigate(pageButton.dataset.page);
    const pageLink = event.target.closest("[data-page-link]");
    if (pageLink) { event.preventDefault(); navigate(pageLink.dataset.pageLink); }
    const goButton = event.target.closest("[data-go]");
    if (goButton) navigate(goButton.dataset.go);
    const starterButton = event.target.closest("[data-starter]");
    if (starterButton) loadStarter(starterButton.dataset.starter);
    const promptButton = event.target.closest("[data-prompt]");
    if (promptButton) submitNote(promptButton.dataset.prompt);
    const example = event.target.closest("[data-query]");
    if (example) {
      $("#compound-query").value = example.dataset.query;
      searchCompounds();
    }
    const activityButton = event.target.closest("[data-activities]");
    if (activityButton) loadActivities(activityButton.dataset.activities, activityButton);
    const admetButton = event.target.closest("[data-admet-scope]");
    if (admetButton) runAdmet(admetButton.dataset.admetScope);
    const remove = event.target.closest("[data-remove]");
    if (remove) {
      state.shortlist.splice(Number(remove.dataset.remove), 1);
      saveShortlist();
      toast("Candidate removed.");
    }
    const openSaved = event.target.closest("[data-open-saved]");
    if (openSaved) openSavedMolecule(state.shortlist[Number(openSaved.dataset.openSaved)]);
    if (event.target.closest("#clear-shortlist")) {
      state.shortlist = [];
      saveShortlist();
      toast("Shortlist cleared.");
    }
  });

  $("#theme-toggle").addEventListener("click", () => setTheme(state.theme === "dark" ? "light" : "dark"));
  $("#analyze-button").addEventListener("click", analyzeCurrent);
  $("#molecule-smiles").addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") analyzeCurrent();
  });
  $("#clear-lab").addEventListener("click", () => {
    $("#molecule-name").value = "";
    $("#molecule-smiles").value = "";
    clearError("lab-error");
  });
  $("#save-candidate").addEventListener("click", () => {
    if (state.active) shortlistMolecule(state.active);
  });
  $("#download-sdf").addEventListener("click", downloadSdf);
  $("#search-button").addEventListener("click", searchCompounds);
  $("#compound-query").addEventListener("keydown", (event) => {
    if (event.key === "Enter") searchCompounds();
  });
  $("#viewer-reset").addEventListener("click", () => {
    const viewer = state.viewers.lab;
    if (!viewer) return;
    viewer.zoomTo();
    viewer.render();
  });
  $("#copilot-form").addEventListener("submit", (event) => {
    event.preventDefault();
    submitNote($("#copilot-input").value);
  });

  function boot() {
    setTheme(state.theme);
    renderStarters();
    renderShortlist();
    renderOverviewActive(null);
    renderCopilotContext();
    const initial = window.location.hash.replace("#", "");
    if (PAGE_LABELS[initial]) navigate(initial);
  }

  boot();
})();


