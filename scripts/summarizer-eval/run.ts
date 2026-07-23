import type {
  SummarizationUsage,
  SummarizeReadingResult,
} from "../../src/modules/summarizer";
import type {
  EvaluationCandidate,
  EvaluationCase,
} from "./fixtures";

export interface EvaluationObservation {
  candidateId: string;
  caseId: string;
  latencyMs: number;
  reading?: SummarizeReadingResult["reading"];
  usage?: SummarizationUsage;
  error?: string;
}

export interface EvaluationRunDeps {
  summarize(
    evaluationCase: EvaluationCase,
    candidate: EvaluationCandidate,
  ): Promise<SummarizeReadingResult>;
  now(): number;
  onProgress?(observation: EvaluationObservation): void;
}

export async function runEvaluationMatrix(
  cases: EvaluationCase[],
  candidates: EvaluationCandidate[],
  deps: EvaluationRunDeps,
): Promise<EvaluationObservation[]> {
  const observations: EvaluationObservation[] = [];
  for (const candidate of candidates) {
    for (const evaluationCase of cases) {
      const startedAt = deps.now();
      let observation: EvaluationObservation;
      try {
        const result = await deps.summarize(evaluationCase, candidate);
        observation = {
          candidateId: candidate.id,
          caseId: evaluationCase.id,
          latencyMs: deps.now() - startedAt,
          reading: result.reading,
          usage: result.usage,
        };
      } catch (error) {
        observation = {
          candidateId: candidate.id,
          caseId: evaluationCase.id,
          latencyMs: deps.now() - startedAt,
          error: error instanceof Error ? error.message : String(error),
        };
      }
      observations.push(observation);
      deps.onProgress?.(observation);
    }
  }
  return observations;
}
