import { Request, Response } from "express";
import { prisma } from "../../infra/prisma/client";
import { getDriverNetworkSnapshot } from "../../domain/services/DriverReferralService";
import { AuthenticatedDriverRequest } from "../middleware/requireDriverAuth";
import { getNetworkRelationships } from "../../domain/referral-network/NetworkGenealogyService";
import { listDriverSkills } from "../../domain/skills/DriverSkillService";
import { getOwnershipMetrics } from "../../domain/referral-network/NetworkOwnershipService";
import { DriverOperationalBaseService } from "../../domain/driver/DriverOperationalBaseService";
import { ReferralFlowType } from "../../shared/enums";
import type { RideStatus } from "../../shared/enums";
import { OfferBookQueryError, offerBookReadService } from "../../application/services/OfferBookReadService";

export class DriverController {
  private async findActivePublicDriver(referralCodeOrSlug: string) {
    return prisma.driver.findFirst({
      where: {
        isActive: true,
        OR: [{ referralCode: referralCodeOrSlug }, { publicSlug: referralCodeOrSlug }],
      },
      select: {
        id: true,
        referralCode: true,
        publicSlug: true,
        experienceLevel: true,
        createdAt: true,
        isActive: true,
        user: { select: { name: true } },
        regions: true,
        vehicles: { select: { brand: true, model: true, category: true } },
      },
    });
  }

  // Perfil público: POST/GET que usa referralCode (mantido por compat)
  async getPublicProfile(req: Request, res: Response) {
    try {
      const { referralCode } = req.params;

      if (!referralCode || typeof referralCode !== "string") {
        return res.status(400).json({ error: "referralCode inválido na URL" });
      }

      const driver = await this.findActivePublicDriver(referralCode);
      if (!driver) {
        return res.status(404).json({ error: "Motorista não encontrado" });
      }

      return res.status(200).json({
        name: driver.user.name,
        referralCode: driver.referralCode,
        experienceLevel: driver.experienceLevel,
        memberSince: driver.createdAt,
        regions: driver.regions,
        vehicles: driver.vehicles,
      });
    } catch (error) {
      console.error("Erro ao carregar perfil público do motorista:", error);
      return res.status(500).json({ error: "Erro interno ao carregar motorista" });
    }
  }

  // Endpoint público canônico: /r/:slug
  async resolvePublicReferral(req: Request, res: Response) {
    try {
      const { slug } = req.params;

      if (!slug || typeof slug !== "string" || !slug.trim()) {
        return res.status(400).json({ error: "slug inválido na URL" });
      }

      const driver = await prisma.driver.findFirst({
        where: {
          isActive: true,
          publicSlug: slug.trim(),
        },
        select: {
          id: true,
          publicSlug: true,
          referralCode: true,
          experienceLevel: true,
          createdAt: true,
          user: { select: { name: true } },
        },
      });

      if (!driver) {
        return res.status(404).json({ error: "Motorista não encontrado" });
      }

      return res.status(200).json({
        slug: slug.trim(),
        referralCode: driver.referralCode,
        driver: {
          id: driver.id,
          name: driver.user.name,
          experienceLevel: driver.experienceLevel,
          memberSince: driver.createdAt,
        },
      });
    } catch (error) {
      console.error("Erro ao resolver slug público de referral:", error);
      return res.status(500).json({ error: "Erro interno ao resolver referral público" });
    }
  }

  // GET /drivers/:driverId/network (canônico de leitura pública da rede)
  async getNetwork(req: Request, res: Response) {
    try {
      const { driverId } = req.params;

      if (!driverId || typeof driverId !== "string") {
        return res.status(400).json({ error: "driverId inválido na URL" });
      }

      const driver = await prisma.driver.findUnique({
        where: { id: driverId },
        select: { id: true, isActive: true },
      });

      if (!driver || !driver.isActive) {
        return res.status(404).json({ error: "Driver não encontrado ou inativo" });
      }

      const [network, ownership] = await Promise.all([
        getDriverNetworkSnapshot(driverId),
        getOwnershipMetrics(driverId).catch(() => null),
      ]);
      return res.status(200).json({
        ...network,
        ridesCompleted: ownership?.completedRidesAttributedToTree ?? 0,
        estimatedRevenue: ownership ? ownership.settledRevenueShareCents / 100 : 0,
      });
    } catch (error) {
      console.error("Erro ao carregar rede do driver:", error);
      return res.status(500).json({
        error: "Erro interno ao carregar rede do driver",
        details: error instanceof Error ? error.message : error,
      });
    }
  }

  // Rotas restantes (offers/rides) - mantidas caso existam testes/consumo antigo
  async getNetworkHierarchy(req: Request, res: Response) {
    try {
      const { driverId } = req.params;

      if (!driverId || typeof driverId !== "string") {
        return res.status(400).json({ error: "driverId inválido na URL" });
      }

      const driver = await prisma.driver.findUnique({
        where: { id: driverId },
        select: {
          id: true,
          isActive: true,
          referralCode: true,
          publicSlug: true,
          user: { select: { name: true } },
        },
      });

      if (!driver || !driver.isActive) {
        return res.status(404).json({ error: "Driver não encontrado ou inativo" });
      }

      const snapshot = await getDriverNetworkSnapshot(driverId);

      return res.status(200).json({
        me: {
          id: driver.id,
          name: driver.user.name,
          referralCode: driver.referralCode,
          publicSlug: driver.publicSlug ?? null,
        },
        levels: snapshot.levels,
        summary: snapshot.summary,
        totalPassengers: snapshot.totalPassengers,
      });
    } catch (error) {
      console.error("Erro ao carregar hierarquia do driver:", error);
      return res.status(500).json({
        error: "Erro interno ao carregar hierarquia do driver",
        details: error instanceof Error ? error.message : error,
      });
    }
  }

  // V2: GET /drivers/:driverId/network/relationships
  async getNetworkRelationships(req: Request, res: Response) {
    try {
      const { driverId } = req.params;
      if (!driverId || typeof driverId !== "string") {
        return res.status(400).json({ error: "driverId inválido na URL" });
      }

      const driver = await prisma.driver.findUnique({
        where: { id: driverId },
        select: { id: true, isActive: true },
      });
      if (!driver || !driver.isActive) {
        return res.status(404).json({ error: "Driver não encontrado ou inativo" });
      }

      const flowTypeParam = typeof req.query.flowType === "string" ? req.query.flowType : undefined;
      let flowType: ReferralFlowType | undefined;
      if (flowTypeParam) {
        if (!Object.values(ReferralFlowType).includes(flowTypeParam as ReferralFlowType)) {
          return res.status(400).json({ error: `flowType inválido. Use: ${Object.values(ReferralFlowType).join(", ")}` });
        }
        flowType = flowTypeParam as ReferralFlowType;
      }

      const response = await getNetworkRelationships(driverId, { flowType });
      return res.status(200).json(response);
    } catch (error) {
      console.error("Erro ao carregar relationships V2:", error);
      return res.status(500).json({
        error: "Erro interno ao carregar relationships",
        details: error instanceof Error ? error.message : error,
      });
    }
  }

  // V2: GET /drivers/:driverId/skills
  async getDriverSkills(req: Request, res: Response) {
    try {
      const { driverId } = req.params;
      if (!driverId || typeof driverId !== "string") {
        return res.status(400).json({ error: "driverId inválido na URL" });
      }
      const driver = await prisma.driver.findUnique({
        where: { id: driverId },
        select: { id: true, isActive: true },
      });
      if (!driver || !driver.isActive) {
        return res.status(404).json({ error: "Driver não encontrado ou inativo" });
      }
      const skills = await listDriverSkills(driverId);
      return res.status(200).json({ driverId, skills });
    } catch (error) {
      console.error("Erro ao listar skills do driver:", error);
      return res.status(500).json({
        error: "Erro interno ao listar skills",
        details: error instanceof Error ? error.message : error,
      });
    }
  }

  async list(req: Request, res: Response) {
    try {
      const drivers = await prisma.driver.findMany({
        where: { isActive: true },
        select: {
          id: true,
          referralCode: true,
          publicSlug: true,
          isActive: true,
          user: {
            select: { id: true, name: true, phone: true },
          },
        },
      });

      return res.status(200).json(
        drivers.map((d) => ({
          id: d.id,
          referralCode: d.referralCode,
          name: d.user.name,
          phone: d.user.phone,
          publicSlug: d.publicSlug,
        }))
      );
    } catch (error) {
      console.error("Erro ao listar motoristas:", error);
      return res.status(500).json({
        error: "Erro interno ao listar motoristas",
        details: error instanceof Error ? error.message : error,
      });
    }
  }


  private async loadOffersForDriver(driverId: string) {
    const offers = await prisma.rideOffer.findMany({
      where: {
        driverId,
        status: "PENDING",
        expiresAt: { gt: new Date() },
      },
      include: {
        rideRequest: {
          select: {
            id: true,
            origin: true,
            destination: true,
            scheduledAt: true,
            status: true,
            priceEstimated: true,
            priceOffered: true,
            distanceKm: true,
            durationMin: true,
            context: true,
            originLat: true,
            originLng: true,
            destinationLat: true,
            destinationLng: true,
            passenger: {
              select: {
                id: true,
                referredByDriverId: true,
                user: { select: { name: true, phone: true } },
              },
            },
          },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    return offers.map((offer) => {
      const rr = offer.rideRequest;
      const ctx = rr.context as Record<string, unknown> | null;
      return {
        ...offer,
        rideRequest: {
          ...rr,
          priceBrl: rr.priceOffered ?? rr.priceEstimated ?? null,
          regionalContext: ctx?.regionalContext ?? null,
        },
      };
    });
  }

  private async loadRidesForDriver(driverId: string) {
    // Rides this driver was selected on (active + terminal), plus terminal
    // rides the driver engaged as M1 pricing driver (having priced the
    // RideQuote) but never got selected on — e.g. administratively cancelled
    // requests that must stay visible in the driver's Histórico.
    // Active statuses feed the "Ativas" tab; terminal ones feed "Histórico".
    // CANCELLED rides are preserved in history — never silently dropped.
    const DRIVER_RIDE_STATUSES: RideStatus[] = [
      "ACCEPTED",
      "IN_PROGRESS",
      "COMPLETED",
      "CANCELLED",
      "REJECTED",
      "EXPIRED",
      "PAID",
    ];
    const TERMINAL_STATUSES: RideStatus[] = [
      "COMPLETED",
      "CANCELLED",
      "REJECTED",
      "EXPIRED",
      "PAID",
    ];
    return prisma.rideRequest.findMany({
      where: {
        OR: [
          {
            selectedDriverId: driverId,
            status: { in: DRIVER_RIDE_STATUSES },
          },
          {
            selectedDriverId: null,
            status: { in: TERMINAL_STATUSES },
            quotes: { some: { pricingDriverId: driverId } },
          },
        ],
      },
      include: {
        passenger: {
          include: {
            user: { select: { name: true, phone: true } },
          },
        },
      },
      orderBy: { scheduledAt: "asc" },
    });
  }

  async getOffers(req: AuthenticatedDriverRequest, res: Response) {
    try {
      const { driverId } = req.params;
      const authDriverId = req.authDriverId;

      if (!driverId || typeof driverId !== "string") {
        return res.status(400).json({ error: "driverId inválido na URL" });
      }

      if (!authDriverId) {
        return res.status(401).json({ error: "Driver authentication required" });
      }

      if (authDriverId !== driverId) {
        return res.status(404).json({ error: "Ofertas do driver não encontradas" });
      }

      const payload = await this.loadOffersForDriver(driverId);

      return res.status(200).json(payload);
    } catch (error) {
      console.error("Erro ao carregar ofertas:", error);
      return res.status(500).json({
        error: "Erro ao carregar ofertas",
        details: error instanceof Error ? error.message : error,
      });
    }
  }

  async listOffers(req: Request, res: Response) {
    // compat: algumas rotas antigas chamam listOffers
    return res.status(410).json({ error: "Use autenticação do driver para offers" });
  }

  async listRides(req: AuthenticatedDriverRequest, res: Response) {
    try {
      const { driverId } = req.params;
      const authDriverId = req.authDriverId;

      if (!driverId || typeof driverId !== "string") {
        return res.status(400).json({ error: "driverId inválido na URL" });
      }

      if (!authDriverId) {
        return res.status(401).json({ error: "Driver authentication required" });
      }

      if (driverId !== authDriverId) {
        return res.status(404).json({ error: "Corridas do driver não encontradas" });
      }

      const rides = await this.loadRidesForDriver(authDriverId);

      return res.status(200).json(rides);
    } catch (error) {
      console.error("Erro ao listar corridas do driver:", error);
      return res.status(500).json({
        error: "Erro interno ao listar corridas",
        details: error instanceof Error ? error.message : error,
      });
    }
  }

  // GET /drivers/me — perfil do driver autenticado via Bearer
  async getMe(req: AuthenticatedDriverRequest, res: Response) {
    try {
      const driverId = req.authDriverId;
      if (!driverId) {
        return res.status(401).json({ error: "Driver authentication required" });
      }

      const driver = await prisma.driver.findUnique({
        where: { id: driverId },
        select: {
          id: true,
          referralCode: true,
          publicSlug: true,
          networkLevel: true,
          referredByDriverId: true,
          experienceLevel: true,
          regions: true,
          isActive: true,
          user: { select: { name: true, email: true, phone: true } },
        },
      });

      if (!driver || !driver.isActive) {
        return res.status(404).json({ error: "Driver não encontrado ou inativo" });
      }

      return res.status(200).json({
        driverId: driver.id,
        name: driver.user.name,
        email: driver.user.email,
        phone: driver.user.phone,
        referralCode: driver.referralCode,
        publicSlug: driver.publicSlug ?? null,
        networkLevel: driver.networkLevel ?? 0,
        referredByDriverId: driver.referredByDriverId ?? null,
        experienceLevel: driver.experienceLevel,
        regions: driver.regions,
      });
    } catch (error) {
      console.error("Erro ao carregar perfil do motorista:", error);
      return res.status(500).json({ error: "Erro interno ao carregar perfil do motorista" });
    }
  }

  // GET /drivers/me/offers — ofertas do driver autenticado via Bearer
  async getMyOffers(req: AuthenticatedDriverRequest, res: Response) {
    const driverId = req.authDriverId;
    if (!driverId) {
      return res.status(401).json({ error: "Driver authentication required" });
    }

    try {
      const payload = await this.loadOffersForDriver(driverId);
      return res.status(200).json(payload);
    } catch (error) {
      console.error("Erro ao carregar ofertas do driver:", error);
      return res.status(500).json({
        error: "Erro ao carregar ofertas",
        details: error instanceof Error ? error.message : error,
      });
    }
  }

  // GET /drivers/me/offers/history — book histórico somente leitura.
  async getMyOfferHistory(req: AuthenticatedDriverRequest, res: Response) {
    const driverId = req.authDriverId;
    if (!driverId) {
      return res.status(401).json({ error: "Driver authentication required" });
    }

    try {
      const page = await offerBookReadService.listForDriver(driverId, {
        limit: req.query.limit,
        cursor: typeof req.query.cursor === "string" ? req.query.cursor : undefined,
      });
      return res.status(200).json(page);
    } catch (error) {
      if (error instanceof OfferBookQueryError) {
        return res.status(400).json({ error: error.message });
      }
      console.error("Erro ao carregar book histórico de ofertas:", error);
      return res.status(500).json({ error: "Erro ao carregar book de ofertas" });
    }
  }

  // GET /drivers/me/rides — corridas do driver autenticado via Bearer
  async getMyRides(req: AuthenticatedDriverRequest, res: Response) {
    const driverId = req.authDriverId;
    if (!driverId) {
      return res.status(401).json({ error: "Driver authentication required" });
    }

    try {
      const rides = await this.loadRidesForDriver(driverId);
      return res.status(200).json(rides);
    } catch (error) {
      console.error("Erro ao listar corridas do driver:", error);
      return res.status(500).json({
        error: "Erro interno ao listar corridas",
        details: error instanceof Error ? error.message : error,
      });
    }
  }

  // GET /drivers/me/operational-base — base operacional do driver autenticado
  // (origem M fixa do pricing M→A). 200 com operationalBase: null quando ainda
  // não configurada — o frontend distingue NO_BASE de CONFIGURED sem depender
  // de 404.
  async getMyOperationalBase(req: AuthenticatedDriverRequest, res: Response) {
    const driverId = req.authDriverId;
    if (!driverId) {
      return res.status(401).json({ error: "Driver authentication required" });
    }

    try {
      const base = await prisma.driverOperationalBase.findUnique({
        where: { driverId },
        select: {
          id: true,
          driverId: true,
          formattedAddress: true,
          providerPlaceId: true,
          latitude: true,
          longitude: true,
          updatedAt: true,
        },
      });

      return res.status(200).json({ operationalBase: base });
    } catch (error) {
      console.error("Erro ao carregar base operacional do motorista:", error);
      return res.status(500).json({ error: "Erro interno ao carregar base operacional" });
    }
  }

  // PUT /drivers/me/operational-base — cria/atualiza a base operacional.
  //
  // Decision B: quando a chave Google está configurada, a base é validada
  // server-side via Place Details a partir do providerPlaceId e as coordenadas
  // autoritativas vêm do Google. Sem chave (dev/tests), coordenadas enviadas
  // pelo cliente dentro dos limites físicos são aceitas como pass-through —
  // NUNCA fora de faixa e NUNCA (0,0): o handler sanitiza e o serviço rejeita
  // base sem geometria utilizável (422 BASE_NOT_RESOLVABLE em vez de persistir
  // lat/lng = 0, que já produziu quotes com M→A de milhares de km).
  async upsertMyOperationalBase(req: AuthenticatedDriverRequest, res: Response) {
    const driverId = req.authDriverId;
    if (!driverId) {
      return res.status(401).json({ error: "Driver authentication required" });
    }

    const body = req.body as Record<string, unknown> | null;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return res.status(400).json({ error: "Corpo deve ser um objeto", code: "INVALID_BODY" });
    }

    const providerPlaceId =
      typeof body.providerPlaceId === "string" ? body.providerPlaceId : null;
    const formattedAddress =
      typeof body.formattedAddress === "string" ? body.formattedAddress : null;

    // Seletor do autocomplete é obrigatório: texto digitado à mão sem
    // providerPlaceId jamais vira base (não resolve coordenadas autoritativas).
    if (!providerPlaceId || !providerPlaceId.trim()) {
      return res.status(422).json({
        error: "providerPlaceId é obrigatório — selecione uma sugestão do Google Places",
        code: "BASE_NOT_RESOLVABLE",
      });
    }

    try {
      // Sanitização das coordenadas candidatas: apenas finitas e dentro dos
      // limites físicos chegam ao serviço. Fora de faixa é tratado como ausente
      // (o cliente nunca define a posição M livremente — só o Google ou um par
      // válido em dev/tests).
      const rawLat = body.latitude;
      const rawLng = body.longitude;
      const candidateLat =
        typeof rawLat === "number" &&
        Number.isFinite(rawLat) &&
        Math.abs(rawLat) <= 90
          ? rawLat
          : null;
      const candidateLng =
        typeof rawLng === "number" &&
        Number.isFinite(rawLng) &&
        Math.abs(rawLng) <= 180
          ? rawLng
          : null;

      const service = new DriverOperationalBaseService();
      const result = await service.save(driverId, {
        providerPlaceId: providerPlaceId.trim(),
        address: formattedAddress,
        ...(candidateLat !== null && candidateLng !== null
          ? { lat: candidateLat, lng: candidateLng }
          : {}),
      });

      if (!result.valid) {
        return res.status(422).json({
          error: result.reason,
          code: result.code,
        });
      }

      const base = await prisma.driverOperationalBase.findUniqueOrThrow({
        where: { driverId },
        select: {
          id: true,
          driverId: true,
          formattedAddress: true,
          providerPlaceId: true,
          latitude: true,
          longitude: true,
          updatedAt: true,
        },
      });

      return res.status(200).json({
        operationalBase: base,
        source: result.source,
      });
    } catch (error) {
      console.error("Erro ao salvar base operacional do motorista:", error);
      return res.status(500).json({ error: "Erro interno ao salvar base operacional" });
    }
  }
}
