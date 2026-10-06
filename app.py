from __future__ import annotations

import json
import os
import re
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from ipaddress import ip_address
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen
from uuid import uuid4

from flask import Flask, jsonify, render_template, request
from flask_limiter import Limiter

try:
    from rdkit import Chem
    from rdkit.Chem import AllChem, Crippen, Descriptors, Lipinski, rdMolDescriptors
except ImportError as exc:
    raise RuntimeError(
        "RDKit is required. Install the project dependencies with: "
        "python -m pip install -r requirements.txt"
    ) from exc


app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 64 * 1024


def _client_ip() -> str:
    # Render's Cloudflare edge overwrites this header with the visitor's address.
    # Do not use the leftmost X-Forwarded-For value; callers can supply that.
    forwarded_ip = request.headers.get("CF-Connecting-IP", "").strip()
    if forwarded_ip:
        try:
            return str(ip_address(forwarded_ip))
        except ValueError:
            app.logger.warning("Ignoring an invalid CF-Connecting-IP header")
    return request.remote_addr or "unknown"


limiter = Limiter(
    key_func=_client_ip,
    app=app,
    storage_uri="memory://",
    headers_enabled=True,
)
DEEP_PK_API = "https://biosig.lab.uq.edu.au/deeppk/api/predict"

STARTER_MOLECULES = {
    "Caffeine": {
        "smiles": "Cn1c(=O)c2c(ncn2C)n(C)c1=O",
        "note": "A familiar xanthine scaffold for exploring the descriptor workflow.",
    },
    "Aspirin": {
        "smiles": "CC(=O)Oc1ccccc1C(=O)O",
        "note": "A compact aromatic example with an ester and carboxylic acid.",
    },
    "Acetaminophen": {
        "smiles": "CC(=O)Nc1ccc(O)cc1",
        "note": "A small aromatic example with one donor and one acceptor group.",
    },
    "Ibuprofen": {
        "smiles": "CC(C)Cc1ccc(cc1)[C@@H](C)C(=O)O",
        "note": "A chiral, lipophilic example for comparing property profiles.",
    },
    "Nicotinamide": {
        "smiles": "NC(=O)c1cccnc1",
        "note": "A small heteroaromatic molecule with an amide group.",
    },
    "Metformin": {
        "smiles": "CN(C)C(=N)NC(=N)N",
        "note": "A compact, nitrogen-rich example with a polar profile.",
    },
}


def _request_json(url: str, timeout: float = 12.0) -> dict:
    req = Request(
        url,
        headers={
            "User-Agent": "DrugForge/3.5 (computational research prototype)",
            "Accept": "application/json",
        },
    )
    with urlopen(req, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def _deep_pk_request(fields: dict[str, str], method: str) -> dict:
    boundary = "DrugForge" + uuid4().hex
    parts = []
    for name, value in fields.items():
        parts.append(
            f"--{boundary}\r\n"
            f'Content-Disposition: form-data; name="{name}"\r\n\r\n'
            f"{value}\r\n"
        )
    parts.append(f"--{boundary}--\r\n")
    body = "".join(parts).encode("utf-8")
    req = Request(
        DEEP_PK_API,
        data=body,
        method=method,
        headers={
            "User-Agent": "DrugForge/3.5 (Deep-PK API client)",
            "Accept": "application/json",
            "Content-Type": f"multipart/form-data; boundary={boundary}",
        },
    )
    with urlopen(req, timeout=25.0) as response:
        return json.loads(response.read().decode("utf-8"))


def _find_deep_pk_record(value: object) -> dict | None:
    if isinstance(value, dict):
        if any(str(key).startswith("Predictions_") for key in value):
            return value
        for child in value.values():
            record = _find_deep_pk_record(child)
            if record is not None:
                return record
    elif isinstance(value, list):
        for child in value:
            record = _find_deep_pk_record(child)
            if record is not None:
                return record
    return None


def analyze_smiles(name: str, smiles: str, source: str = "Manual entry") -> dict:
    mol = Chem.MolFromSmiles(smiles)
    if mol is None:
        raise ValueError(
            "That SMILES string could not be parsed. Check the characters, "
            "brackets, and stereochemistry, then try again."
        )
    if mol.GetNumHeavyAtoms() > 250:
        raise ValueError(
            "This prototype limits conformer generation to 250 heavy atoms "
            "so interactive 3D rendering stays responsive."
        )

    props = {
        "Molecular weight": round(Descriptors.MolWt(mol), 2),
        "cLogP": round(Crippen.MolLogP(mol), 2),
        "H-bond donors": int(Lipinski.NumHDonors(mol)),
        "H-bond acceptors": int(Lipinski.NumHAcceptors(mol)),
        "TPSA": round(rdMolDescriptors.CalcTPSA(mol), 2),
        "Rotatable bonds": int(Lipinski.NumRotatableBonds(mol)),
        "Rings": int(Lipinski.RingCount(mol)),
        "Heavy atoms": int(mol.GetNumHeavyAtoms()),
        "Formula": rdMolDescriptors.CalcMolFormula(mol),
    }
    checks = {
        "Molecular weight ≤ 500 Da": props["Molecular weight"] <= 500,
        "cLogP ≤ 5": props["cLogP"] <= 5,
        "H-bond donors ≤ 5": props["H-bond donors"] <= 5,
        "H-bond acceptors ≤ 10": props["H-bond acceptors"] <= 10,
        "TPSA ≤ 140 Å²": props["TPSA"] <= 140,
    }

    # Generate one reproducible 3D conformer and relax it with a force field.
    mol3d = Chem.AddHs(mol)
    params = AllChem.ETKDGv3()
    params.randomSeed = 0xDF03
    params.numThreads = 1
    embedded = AllChem.EmbedMolecule(mol3d, params)
    if embedded < 0:
        params.useRandomCoords = True
        embedded = AllChem.EmbedMolecule(mol3d, params)
    if embedded < 0:
        raise ValueError(
            "RDKit could not generate a 3D conformer for this structure. "
            "Try a different stereochemical form or a smaller molecule."
        )

    if AllChem.MMFFHasAllMoleculeParams(mol3d):
        AllChem.MMFFOptimizeMolecule(mol3d, maxIters=180)
    elif AllChem.UFFHasAllMoleculeParams(mol3d):
        AllChem.UFFOptimizeMolecule(mol3d, maxIters=180)

    mol3d = Chem.RemoveHs(mol3d)
    molblock = Chem.MolToMolBlock(mol3d)
    canonical = Chem.MolToSmiles(mol, isomericSmiles=True)

    return {
        "name": name.strip() or "Untitled molecule",
        "smiles": canonical,
        "source": source,
        "created": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
        "properties": props,
        "checks": checks,
        "score": int(round(100 * sum(checks.values()) / len(checks))),
        "molblock": molblock,
    }


def _pubchem_lookup(query: str, query_type: str) -> dict:
    namespace = "smiles" if query_type == "SMILES" else "name"
    encoded = quote(query.strip(), safe="")
    base = "https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound"
    try:
        cid_data = _request_json(f"{base}/{namespace}/{encoded}/cids/JSON")
        cids = cid_data.get("IdentifierList", {}).get("CID", [])
        if not cids:
            return {"status": "not_found"}
        cid = cids[0]
        fields = "MolecularFormula,MolecularWeight,IUPACName,InChIKey,SMILES,ConnectivitySMILES,XLogP,Title"
        data = _request_json(f"{base}/cid/{cid}/property/{fields}/JSON")
        records = data.get("PropertyTable", {}).get("Properties", [])
        if not records:
            return {"status": "not_found"}
        properties = dict(records[0])
        properties["CID"] = cid
        properties["match_count"] = len(cids)
        return {"status": "found", "properties": properties}
    except HTTPError as exc:
        if exc.code in (400, 404):
            return {"status": "not_found"}
        return {"status": "unavailable", "error": f"PubChem returned HTTP {exc.code}."}
    except (URLError, TimeoutError, ValueError, KeyError) as exc:
        return {"status": "unavailable", "error": f"PubChem could not be reached: {exc}"}


def _chembl_lookup(query: str, query_type: str) -> dict:
    if query_type == "SMILES":
        mol = Chem.MolFromSmiles(query.strip())
        if mol is None:
            return {"status": "not_found", "molecules": []}
        connectivity = Chem.MolToSmiles(mol, isomericSmiles=False)
        params = urlencode(
            {"molecule_structures__canonical_smiles__connectivity": connectivity, "limit": 5}
        )
        url = f"https://www.ebi.ac.uk/chembl/api/data/molecule.json?{params}"
    else:
        params = urlencode({"q": query.strip(), "limit": 5})
        url = f"https://www.ebi.ac.uk/chembl/api/data/molecule/search.json?{params}"
    try:
        data = _request_json(url)
        molecules = data.get("molecules", [])
        return {"status": "found" if molecules else "not_found", "molecules": molecules}
    except HTTPError as exc:
        if exc.code == 404:
            return {"status": "not_found", "molecules": []}
        return {
            "status": "unavailable",
            "molecules": [],
            "error": f"ChEMBL returned HTTP {exc.code}.",
        }
    except (URLError, TimeoutError, ValueError) as exc:
        return {
            "status": "unavailable",
            "molecules": [],
            "error": f"ChEMBL could not be reached: {exc}",
        }


def _resolve_query_type(query: str, requested_type: str) -> str:
    if requested_type in {"Name", "SMILES"}:
        return requested_type
    return "SMILES" if Chem.MolFromSmiles(query.strip()) is not None else "Name"


@app.get("/")
def index():
    return render_template("index.html", starters=STARTER_MOLECULES)


@app.get("/api/health")
def health():
    return jsonify({"status": "ok", "service": "DrugForge"})


@app.get("/api/starters")
def starters():
    return jsonify(STARTER_MOLECULES)


@app.post("/api/analyze")
@limiter.limit("20 per minute; 200 per hour")
def api_analyze():
    data = request.get_json(silent=True) or {}
    smiles = str(data.get("smiles", "")).strip()
    name = str(data.get("name", "")).strip()
    source = str(data.get("source", "Manual entry")).strip()[:120]
    if not smiles:
        return jsonify({"error": "Enter a SMILES string to analyze."}), 400
    if len(smiles) > 1200:
        return jsonify({"error": "SMILES input is too long. Please keep it under 1,200 characters."}), 413
    try:
        return jsonify(analyze_smiles(name, smiles, source))
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 422
    except Exception:
        app.logger.exception("Molecule analysis failed")
        return jsonify({"error": "The molecule could not be analyzed. Check the structure and try again."}), 500


@app.post("/api/search")
@limiter.limit("15 per minute; 150 per hour")
def api_search():
    data = request.get_json(silent=True) or {}
    query = str(data.get("query", "")).strip()
    requested_type = str(data.get("query_type", "Auto-detect"))
    if not query:
        return jsonify({"error": "Enter a compound name or SMILES string."}), 400
    if len(query) > 1200:
        return jsonify({"error": "Search input is too long. Please keep it under 1,200 characters."}), 413

    query_type = _resolve_query_type(query, requested_type)
    with ThreadPoolExecutor(max_workers=2) as pool:
        pubchem_future = pool.submit(_pubchem_lookup, query, query_type)
        chembl_future = pool.submit(_chembl_lookup, query, query_type)
        pubchem = pubchem_future.result()
        chembl = chembl_future.result()

    chembl_molecules = chembl.get("molecules", [])
    chembl_structure = {}
    if chembl_molecules:
        chembl_structure = chembl_molecules[0].get("molecule_structures") or {}

    pubchem_props = pubchem.get("properties", {})
    smiles = (
        pubchem_props.get("SMILES")
        or pubchem_props.get("ConnectivitySMILES")
        or chembl_structure.get("canonical_smiles")
    )
    resolved_name = (
        pubchem_props.get("Title")
        or (chembl_molecules[0].get("pref_name") if chembl_molecules else None)
        or (chembl_molecules[0].get("molecule_chembl_id") if chembl_molecules else None)
        or query
    )
    molecule = None
    analysis_error = None
    if smiles:
        try:
            molecule = analyze_smiles(resolved_name, smiles, "PubChem / ChEMBL")
        except ValueError as exc:
            analysis_error = str(exc)

    return jsonify({
        "query": query,
        "query_type": query_type,
        "pubchem": pubchem,
        "chembl": chembl,
        "molecule": molecule,
        "analysis_error": analysis_error,
    })


@app.post("/api/activities")
@limiter.limit("30 per minute; 300 per hour")
def api_activities():
    data = request.get_json(silent=True) or {}
    chembl_id = str(data.get("chembl_id", "")).strip().upper()
    if not chembl_id.startswith("CHEMBL") or len(chembl_id) > 24:
        return jsonify({"error": "Choose a valid ChEMBL compound record."}), 400
    params = urlencode({
        "molecule_chembl_id": chembl_id,
        "standard_type__in": "IC50,EC50,Ki,Kd,Potency",
        "order_by": "-pchembl_value",
        "limit": 20,
        "only": (
            "activity_id,assay_chembl_id,assay_description,assay_type,"
            "target_chembl_id,target_pref_name,target_organism,standard_type,"
            "standard_relation,standard_value,standard_units,pchembl_value,"
            "document_chembl_id,document_year,data_validity_comment"
        ),
    })
    try:
        data = _request_json(f"https://www.ebi.ac.uk/chembl/api/data/activity.json?{params}")
        return jsonify({
            "status": "found",
            "activities": data.get("activities", []),
            "total": data.get("page_meta", {}).get("total_count"),
        })
    except (HTTPError, URLError, TimeoutError, ValueError) as exc:
        return jsonify({
            "status": "unavailable",
            "error": f"Could not retrieve ChEMBL activity records: {exc}",
            "activities": [],
        }), 502


@app.post("/api/admet/submit")
@limiter.limit("3 per minute; 30 per day")
def api_admet_submit():
    data = request.get_json(silent=True) or {}
    smiles = str(data.get("smiles", "")).strip()
    if not smiles:
        return jsonify({"error": "Analyze a molecule before requesting an ADMET profile."}), 400
    if len(smiles) > 1200:
        return jsonify({"error": "SMILES input is too long."}), 413
    mol = Chem.MolFromSmiles(smiles)
    if mol is None:
        return jsonify({"error": "The submitted SMILES string is invalid."}), 422

    canonical_smiles = Chem.MolToSmiles(mol, isomericSmiles=True)
    try:
        result = _deep_pk_request(
            {"smiles": canonical_smiles, "pred_type": "admet"},
            "POST",
        )
        job_id = str(result.get("job_id", "")).strip()
        if not job_id:
            return jsonify({"error": "Deep-PK did not return a prediction job ID."}), 502
        return jsonify({"status": "submitted", "job_id": job_id})
    except HTTPError as exc:
        app.logger.warning("Deep-PK submission returned HTTP %s", exc.code)
        return jsonify({"error": f"Deep-PK rejected the request (HTTP {exc.code}). Try again later."}), 502
    except (URLError, TimeoutError, ValueError, OSError) as exc:
        app.logger.warning("Deep-PK submission failed: %s", exc)
        return jsonify({"error": "Deep-PK could not be reached. Check the connection and try again."}), 502


@app.post("/api/admet/status")
@limiter.limit("120 per minute; 5000 per day")
def api_admet_status():
    data = request.get_json(silent=True) or {}
    job_id = str(data.get("job_id", "")).strip()
    if not re.fullmatch(r"admet_[0-9.]+", job_id):
        return jsonify({"error": "That Deep-PK job ID is invalid."}), 400
    try:
        result = _deep_pk_request({"job_id": job_id}, "GET")
        record = _find_deep_pk_record(result)
        if record is not None:
            return jsonify({"status": "complete", "record": record})
        remote_status = str(result.get("status", "")).lower() if isinstance(result, dict) else ""
        if remote_status in {"running", "queued", "pending", "processing"}:
            return jsonify({"status": "running"})
        if remote_status in {"failed", "error"}:
            return jsonify({"status": "failed", "error": "Deep-PK could not process this molecule."}), 502
        return jsonify({"status": "running"})
    except HTTPError as exc:
        app.logger.warning("Deep-PK status request returned HTTP %s", exc.code)
        return jsonify({"error": f"Deep-PK returned HTTP {exc.code} while checking the job."}), 502
    except (URLError, TimeoutError, ValueError, OSError) as exc:
        app.logger.warning("Deep-PK status request failed: %s", exc)
        return jsonify({"error": "Could not retrieve the Deep-PK prediction status."}), 502


@app.errorhandler(413)
def request_too_large(_error):
    return jsonify({"error": "Request payload is too large."}), 413


@app.errorhandler(429)
def rate_limit_exceeded(error):
    response = jsonify({"error": "Too many requests. Please wait before trying again."})
    retry_after = error.get_response().headers.get("Retry-After")
    if retry_after:
        response.headers["Retry-After"] = retry_after
    return response, 429


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "5000"))
    app.run(host="127.0.0.1", port=port, debug=False)
