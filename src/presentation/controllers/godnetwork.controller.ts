import { Request, Response } from "express";
import {
  assertConformance,
  getOfficialStructure,
} from "../../domain/godnetwork/GodNetworkService";

export class GodNetworkController {
  async getStatus(_req: Request, res: Response) {
    try {
      const conformance = await assertConformance();
      return res.status(200).json({
        ...conformance,
        officialStructure: getOfficialStructure(),
      });
    } catch (error) {
      console.error("Erro ao calcular conformidade GodNetwork:", error);
      return res.status(500).json({
        error: "Erro interno ao calcular conformidade GodNetwork",
        details: error instanceof Error ? error.message : error,
      });
    }
  }
}
