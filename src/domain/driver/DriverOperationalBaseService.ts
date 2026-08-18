// DriverOperationalBaseService — persistência da base operacional (Fase E).
//
// A base operacional (endereço M fixo) é validada no servidor via Google Place
// Details (New) reusando PlaceValidationService, que degrada para pass-through
// quando a chave está ausente (dev/tests). Uma única base por driver (upsert).

import { prisma } from "../../infra/prisma/client";
import {
  OperationalBaseInput,
  OperationalBaseResult,
  PlaceValidationService,
} from "../places/PlaceValidationService";

type Db = Pick<typeof prisma, "driverOperationalBase">;

export type SaveBaseResult =
  | (Extract<OperationalBaseResult, { valid: true }> & { saved: true })
  | (Extract<OperationalBaseResult, { valid: false }> & { saved: false });

/**
 * Valida e persiste a base operacional de um driver. Quando providerPlaceId é
 * informado, coordenadas autoritativas vêm do Google. Upsert por driver.
 */
export class DriverOperationalBaseService {
  constructor(
    private readonly validation: PlaceValidationService = new PlaceValidationService(),
    private readonly db: Db = prisma,
  ) {}

  async save(
    driverId: string,
    input: OperationalBaseInput,
  ): Promise<SaveBaseResult> {
    const validated = await this.validation.validateBase(input);

    if (!validated.valid) {
      return { ...validated, saved: false };
    }

    await this.db.driverOperationalBase.upsert({
      where: { driverId },
      update: {
        formattedAddress: validated.address ?? "Base operacional",
        providerPlaceId: validated.providerPlaceId,
        latitude: validated.lat,
        longitude: validated.lng,
      },
      create: {
        driverId,
        formattedAddress: validated.address ?? "Base operacional",
        providerPlaceId: validated.providerPlaceId,
        latitude: validated.lat,
        longitude: validated.lng,
      },
    });

    return { ...validated, saved: true };
  }
}