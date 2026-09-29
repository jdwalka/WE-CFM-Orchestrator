export interface InferenceRecord {
  id: string;
  prompt: string;
  context: Record<string, any>;
  result: any;
  createdAt: string;
  source: string;
}

export const getInferenceHistory = async (limit: number): Promise<InferenceRecord[]> => {
  return [];
};

export const runInference = async (prompt: string, context: any): Promise<InferenceRecord> => {
  throw new Error("AI Service is not configured for web deployment yet.");
};
