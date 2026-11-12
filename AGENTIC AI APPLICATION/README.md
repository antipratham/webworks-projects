# Company Research + WebWorks Template PDF Agent

Pipeline:

1. **Stage 1 — Research** -> `reports/<slug>_YYYY-MM-DD.md`  
2. **Stage 2 — Analysis JSON** -> `proposals/<slug>/<slug>_analysis.json` (grounded strengths/gaps/services)  
3. **Stage 3 — Template PDF** -> Node `pdf-service/` overlays text onto the 3-page WebWorks `template.pdf` via pdf-lib  
4. **Stage 4 — Deploy** (optional) -> Netlify CLI / Drop of the proposal folder (PDF + index)

## Setup

```bash
pip install -r requirements.txt
playwright install chromium
cd pdf-service && npm install && cd ..
```

Fonts live in `pdf-service/assets/fonts/` (League Spartan, Poppins, Raleway).  
Template: `pdf-service/assets/template.pdf` (copied from `Sales Proposal WebWorks Co. Template V3 (2).pdf`).

`.env`: `LLM_BACKEND=groq|gemini`, API keys, `DEPLOY_PROPOSALS=false`.

## Run

```bash
# Full pipeline
python main.py --name Zoho --url https://www.zoho.com --requirements "Improve SEO"

# Preview content JSON without rendering PDF
python main.py --name Zoho --url https://www.zoho.com --dry-run

# PDF only from hand-written / saved analysis JSON
python main.py --pdf-only pdf-service/samples/sample_payload.json --out proposals/acme-retail/acme-retail_proposal.pdf

# Node-only smoke test
cd pdf-service
Get-Content samples/sample_payload.json -Raw | node generate.mjs samples/sample_out.pdf
Get-Content samples/sample_payload.json -Raw | node generate.mjs --dry-run

streamlit run app.py
```

## Notes

- Social platforms are not scraped — only `<a href>` on the prospect site.  
- Review sites: search snippets only.  
- If you have the original `sales-tool` `buildProposalPdf.js`, replace `pdf-service/buildProposalPdf.js` (same export API).  
- Cover template may include a sample client name; the renderer whites out that band and draws the real company.
