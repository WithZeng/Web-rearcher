export interface SearchPreset {
  id: "quick" | "standard" | "deep";
  label: string;
  targetPassedCount: number;
  maxUniqueCandidates: number;
  description: string;
}

export interface SearchRecommendation {
  preset: SearchPreset;
  recommendedDatabases: string[];
  reasons: string[];
}

export const SEARCH_PRESETS: SearchPreset[] = [
  {
    id: "quick",
    label: "快搜",
    targetPassedCount: 20,
    maxUniqueCandidates: 200,
    description: "先验证关键词方向，尽快拿到一批候选。",
  },
  {
    id: "standard",
    label: "常规",
    targetPassedCount: 40,
    maxUniqueCandidates: 500,
    description: "日常正式检索，平衡速度与质量。",
  },
  {
    id: "deep",
    label: "深挖",
    targetPassedCount: 80,
    maxUniqueCandidates: 1200,
    description: "适合高质量滚动建库，不建议无限拉长单任务。",
  },
];

const CORE_TERMS = [
  "gelma", "gel-ma", "gelatin methacryloyl", "gelatin methacrylate",
  "microsphere", "microparticle", "microgel", "microcarrier", "microbead",
  "drug release", "controlled release", "sustained release",
  "encapsulation", "drug loading", "release kinetics",
];

const MATERIAL_TERMS = [
  "fabrication", "characterization", "particle size", "degree of substitution",
  "methacrylation", "hydrogel", "polymer", "crosslink", "microstructure",
];

const BIOMED_TERMS = [
  "glioblastoma", "tumor", "cancer", "bone", "regeneration", "macrophage",
  "inflammation", "apoptosis", "pathway", "cell", "in vivo", "in vitro",
];

function hitsForTerms(query: string, terms: string[]): number {
  const lowered = query.toLowerCase();
  return terms.reduce((count, term) => count + (lowered.includes(term) ? 1 : 0), 0);
}

export function recommendSearchSetup(query: string, availableDatabases: string[]): SearchRecommendation {
  const coreHits = hitsForTerms(query, CORE_TERMS);
  const materialHits = hitsForTerms(query, MATERIAL_TERMS);
  const biomedHits = hitsForTerms(query, BIOMED_TERMS);

  const scores = new Map<string, number>();
  for (const db of availableDatabases) {
    scores.set(db, 0);
  }

  const addScore = (db: string, score: number) => {
    scores.set(db, (scores.get(db) ?? 0) + score);
  };

  if (coreHits > 0) {
    addScore("OpenAlex", 4 + coreHits);
    addScore("CrossRef", 4 + coreHits);
    addScore("PubMed", 3 + Math.min(coreHits, 2));
    addScore("Semantic Scholar", 3 + Math.min(coreHits, 2));
  }

  if (materialHits > 0) {
    addScore("OpenAlex", 3 + materialHits);
    addScore("CrossRef", 3 + materialHits);
    addScore("Semantic Scholar", 2 + materialHits);
  }

  if (biomedHits > 0) {
    addScore("PubMed", 4 + biomedHits);
    addScore("Semantic Scholar", 3 + biomedHits);
    addScore("OpenAlex", 1 + Math.min(biomedHits, 2));
  }

  if (coreHits === 0 && materialHits === 0 && biomedHits === 0) {
    addScore("OpenAlex", 3);
    addScore("CrossRef", 3);
    addScore("PubMed", 2);
    addScore("Semantic Scholar", 2);
  }

  const recommendedDatabases = Array.from(scores.entries())
    .sort((a, b) => b[1] - a[1])
    .filter(([, score]) => score > 0)
    .slice(0, 4)
    .map(([db]) => db);

  const reasons: string[] = [];
  if (coreHits > 0) reasons.push("命中 GelMA / 微球 / 释放核心词，优先材料 + 生物医学混合库");
  if (materialHits > 0) reasons.push("偏制备与表征，提升 OpenAlex / CrossRef / Semantic Scholar 权重");
  if (biomedHits > 0) reasons.push("偏疾病或机制，提升 PubMed / Semantic Scholar 权重");
  if (reasons.length === 0) reasons.push("未识别明显领域倾向，使用通用高覆盖组合");

  let preset = SEARCH_PRESETS[1];
  if (coreHits + materialHits + biomedHits <= 1) {
    preset = SEARCH_PRESETS[0];
  } else if (coreHits >= 3 || materialHits >= 2) {
    preset = SEARCH_PRESETS[2];
  }

  return {
    preset,
    recommendedDatabases: recommendedDatabases.length > 0 ? recommendedDatabases : availableDatabases.slice(0, 4),
    reasons,
  };
}
