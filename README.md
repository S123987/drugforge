# DrugForge v3.5 — Molecular research workspace

DrugForge is a browser-first Python website for early-stage small-molecule exploration. It keeps the research workflow—SMILES analysis, compound lookup, candidate comparison, a starter library, and transparent research notes—and renders generated 3D conformers in an interactive browser viewer.

> This is a computational research prototype, not a clinical or decision-support system. It does not predict binding, potency, safety, efficacy, or whether a compound is suitable for treatment.

## What is included

- **Molecule Lab:** analyze a SMILES string with RDKit, calculate common descriptors, and generate one reproducible 3D conformer. Drag to rotate, use the wheel to zoom, and use Ctrl+drag or the middle mouse button to pan.
- **3D viewer:** 3Dmol.js renders the RDKit SDF conformer using WebGL. This is a generated conformer, not an experimental pose or protein-bound structure.
- **Compound Explorer:** search a compound name or SMILES against PubChem and ChEMBL; open matched records and retrieve a small set of ChEMBL assay records.
- **ADMET profile:** optionally submit the selected SMILES to the official Deep-PK API associated with the pkCSM research group. DrugForge displays returned absorption, distribution, metabolism, excretion, toxicity, and general-property model outputs, including available probabilities and interpretations.
- **Candidate Comparison:** save computed profiles in the current browser and compare descriptors side by side. The shortlist stays in that browser and is not uploaded or synced.
- **Starter Library:** caffeine, aspirin, acetaminophen, ibuprofen, nicotinamide, and metformin.
- **Research Notes:** a rule-based explainer grounded in the active profile and shortlist. It does not call a language model or retrieve papers.
- **Light/dark themes:** restrained grey and white surfaces in light mode; pink, blue, and red neon accents in dark mode.
- **Responsive layout:** works on laptop, tablet, and phone browsers.

## Run locally on Windows

### Requirements

- Windows 10 or 11, 64-bit
- Python 3.12 recommended (Python 3.11 also works)
- Visual Studio Code, if you want to edit the project
- Internet access for installing packages, loading the 3D viewer library, retrieving PubChem/ChEMBL records, and optionally submitting a structure to Deep-PK

RDKit performs descriptor calculations and conformer generation locally. The 3Dmol.js viewer, live compound searches, and optional Deep-PK ADMET predictions need internet access. If the viewer CDN cannot load, the rest of the page remains available but 3D rendering will not.

### Option A: launch with the included file

1. Install 64-bit Python 3.12 from [python.org](https://www.python.org/downloads/). During setup, enable **Add Python to PATH**.
2. Open the DrugForge folder in Visual Studio Code or File Explorer.
3. Double-click **run_windows.bat**.
4. Wait for the dependency installation to finish, then open **http://127.0.0.1:5000** in your browser.
5. Keep the terminal window open while using DrugForge. Press Ctrl+C in that window to stop the server.

The first launch creates a local virtual environment and installs Flask, RDKit, and the production WSGI server. Gunicorn is skipped on Windows; the local site uses Flask's built-in development server.

### Option B: run from Visual Studio Code

Open the DrugForge folder in VS Code, then open **Terminal → New Terminal**. Run:

```powershell
py -3.12 --version
py -3.12 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
python app.py
```

Then open **http://127.0.0.1:5000** in your browser. Leave the terminal running; Ctrl+C stops DrugForge.

If PowerShell blocks virtual-environment activation, skip the activation command and call the virtual-environment Python directly:

```powershell
.\.venv\Scripts\python.exe -m pip install --upgrade pip
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe app.py
```

In VS Code, use **Python: Select Interpreter** and choose the Python executable under .venv\Scripts to get the project interpreter and diagnostics.

### Repair an old or broken environment

If an old virtual environment points to a Python installation that has since moved or been removed, close the running server, remove only the generated .venv folder from the DrugForge folder using VS Code Explorer, then open a new terminal and run:

```powershell
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install --upgrade pip
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe app.py
```

Your source files and browser shortlist are separate from this environment folder.

## Deploy publicly with a domain

DrugForge is a Python web service because RDKit calculates descriptors and conformers on the server. The repository includes render.yaml for a Render deployment. No API key is needed for the public PubChem or ChEMBL endpoints.

### 1. Put DrugForge in its own GitHub repository

Create a GitHub repository called drugforge. The easiest deployment layout is to put the contents of this folder at the repository root:

```text
drugforge/
├── app.py
├── requirements.txt
├── render.yaml
├── .python-version
├── templates/
└── static/
```

This deliverable folder may be nested inside a larger local workspace. To keep its deployment history separate, copy the DrugForge folder to a standalone location first, such as Documents\DrugForge, then create/connect the GitHub repository from that copied folder. Alternatively, keep the larger repository and set Render's **Root Directory** to the path containing app.py, such as outputs/drugforge.

With Git installed, the standalone-folder workflow is:

```powershell
Set-Location "C:\Path\To\DrugForge"
git init
git add app.py requirements.txt render.yaml .python-version .gitignore README.md templates static
git commit -m "Prepare DrugForge web deployment"
git branch -M main
git remote add origin https://github.com/YOUR-USERNAME/drugforge.git
git push -u origin main
```

Replace the example path and GitHub username with yours. GitHub Desktop can do the same setup visually if you prefer.

### 2. Create the Render web service

1. Create/sign in to a [Render account](https://render.com/).
2. Choose **New → Blueprint** (or **New → Web Service**) and connect your GitHub repository.
3. For a Blueprint, Render reads render.yaml. For a manual Web Service, set:
   - Runtime: **Python 3**
   - Build command: pip install -r requirements.txt
   - Start command: gunicorn --workers 1 --threads 4 --bind 0.0.0.0:$PORT app:app
   - Health check path: /api/health
   - Root directory: the directory containing app.py, if the app is nested in a larger repository
4. Keep Python on version 3.12. The repository's .python-version requests it.
5. Deploy. Render gives the service an onrender.com address. Open it and try a starter molecule and a compound search.

Render's free web service plan currently supports custom domains and managed TLS, but it sleeps after 15 minutes without incoming traffic. The first request after sleeping can take about a minute to wake. Free-service filesystems are ephemeral, so this prototype intentionally keeps no server-side user data. For a continuously responsive public service, choose a currently available always-on plan. Check Render's current plan details before committing to charges.

### 3. Connect your domain

You purchase a domain separately from a registrar such as Cloudflare Registrar, Namecheap, or another provider. The registrar and the hosting service are separate: Render hosts the app, while your registrar controls the domain's DNS.

1. In Render, open the DrugForge service → **Settings → Custom Domains** → **Add Custom Domain**. Add your root domain (for example, example.com) and optionally www.example.com.
2. In your registrar's DNS manager, create the records Render displays for your exact service and domain. A www hostname is commonly a CNAME to the service's onrender.com hostname; for a root/apex domain, use the A/ALIAS/ANAME records Render shows for your DNS provider. DNS providers handle apex records differently, so use the values shown by Render rather than guessing.
3. Remove conflicting AAAA records while configuring the domain. If you use Cloudflare DNS, leave proxying disabled until Render verifies the domain.
4. Return to Render and click **Verify**. DNS propagation may take a little time.
5. Once verified, Render provisions and renews the TLS certificate automatically and redirects HTTP traffic to HTTPS. Keep the onrender.com address as a fallback or disable it from the service settings later.

A custom domain itself is usually a separate recurring purchase from the registrar; its price depends on the domain ending and provider.

## Public prototype notes

- The website has no sign-in, rate limiting, or server-side database. Shortlists stay in a visitor's browser. Add authentication, request throttling, monitoring, and an appropriate data policy before opening it to high-volume public traffic.
- Compound searches send the entered query to PubChem and ChEMBL. These services may be temporarily unavailable and their records can be incomplete or assay-specific.
- ADMET runs are optional and require a separate button click. The selected SMILES is sent to Deep-PK at the University of Queensland. Its privacy page says submitted molecule data are deleted seven days after results are ready; do not submit confidential or unpublished structures. Results are third-party model estimates, not measured data.
- The 3D model is generated from the input SMILES. It is not a docking result, experimentally determined conformation, or prediction of a protein interaction.
- The five Lipinski-style thresholds contribute equally to a percentage shown in the interface; the percentage is not a validated drug-likeness, ADMET, efficacy, or safety score.
- No user account, uploaded dataset, or API credential is required.

## Main files

- app.py — Flask routes, RDKit analysis and conformer generation, and database API calls
- templates/index.html — full-page interface
- static/styles.css — responsive light/dark visual system
- static/app.js — browser interactions, viewer, search display, comparison, and notes
- requirements.txt — Python dependencies
- render.yaml — Render deployment blueprint
- run_windows.bat — Windows setup and launch helper

## Sources and acknowledgements

- [RDKit](https://www.rdkit.org/) for cheminformatics and conformer generation
- [3Dmol.js](https://3dmol.org/doc/) for browser-based molecular visualization
- [PubChem PUG REST](https://pubchem.ncbi.nlm.nih.gov/docs/pug-rest) for public compound records
- [ChEMBL Web Services](https://chembl.gitbook.io/chembl-interface-documentation/web-services/chembl-data-web-services) for compound and bioactivity records
- [Deep-PK API](https://biosig.lab.uq.edu.au/deeppk/api_docs) for optional ADMET estimates; see its [privacy notice](https://biosig.lab.uq.edu.au/deeppk/privacy)
- [Render](https://render.com/docs) for hosting and custom-domain configuration
