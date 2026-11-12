/**
 * Turns { form, analysis } into the `content` object expected by buildProposalPdf.
 * Frontend and backend both call this file - keep as the single content mapper.
 */
import { COMPANY, WHY_POINTS } from "./proposalData.js";

function mapTitleTextList(arr) {
  if (!Array.isArray(arr)) return [];
  return arr
    .map((p) => ({
      title: String(p?.title || "").trim(),
      text: String(p?.text || "").trim(),
    }))
    .filter((p) => p.text);
}

/**
 * @param {{ form: object, analysis: object }} args
 * @returns {object} content
 */
export function buildProposalContent({ form = {}, analysis = {} } = {}) {
  const company = String(form.company || analysis.company || "Prospect").trim();
  // Prefer MCA/registry legal name when Stage 1 found one; else form.company
  const companyLegalName = String(
    form.companyLegalName || analysis.companyLegalName || company
  ).trim() || company;
  const industry = String(form.industry || analysis.industry || "digital").trim();
  const servicesNeeded = String(form.servicesNeeded || "").trim();
  const llmSubtitle = String(analysis.subtitle || "").trim();

  const whyPoints = (Array.isArray(analysis.whyPoints) && analysis.whyPoints.length
    ? analysis.whyPoints
    : WHY_POINTS
  ).map((p) => String(p).replaceAll("{industry}", industry));

  const painPoints = mapTitleTextList(analysis.painPoints);

  // Strengths: only from analysis - never fabricate a fallback list
  const strengths = mapTitleTextList(analysis.strengths);

  const tactics = Array.isArray(analysis.tactics)
    ? analysis.tactics.map((t) => String(t).trim()).filter(Boolean)
    : [];

  const deliverables = Array.isArray(analysis.deliverables)
    ? analysis.deliverables.map((t) => String(t).trim()).filter(Boolean)
    : [];

  return {
    company,
    companyLegalName,
    title: ` Sales Proposal for ${company} Prepared by WebWorks Co. `,
    subtitle: llmSubtitle
      || (servicesNeeded ? `Focus: ${servicesNeeded}` : `${COMPANY.name} x ${company}`),
    industry,
    whoYouAre: String(analysis.whoYouAre || "").trim(),
    opportunity: String(analysis.opportunity || "").trim(),
    strengths,
    painPoints,
    solutionPitch: String(analysis.solutionPitch || "").trim(),
    tactics,
    deliverables,
    whyPoints,
    // cta intentionally omitted from rendered content
  };
}
