import express, { NextFunction, Request, Response } from "express";
import cors from "cors";
import dotenv from "dotenv";
import "dotenv/config";

import { rideRoutes } from "./presentation/routes/ride.routes";
import { offerRoutes } from "./presentation/routes/offer.routes";
import { passengerRoutes } from "./presentation/routes/passenger.routes";
import { driverRoutes } from "./presentation/routes/driver.routes";
import { canonicalPublicRoutes, publicRoutes } from "./presentation/routes/public.routes";
import { authRoutes } from "./presentation/routes/auth.routes";
import { testRoutes } from "./presentation/routes/test.routes";
import { godnetworkRoutes } from "./presentation/routes/godnetwork.routes";
import { ridesPaymentRouter, pixWebhookRouter } from "./presentation/routes/payment.routes";
import { rideLifecycleRouter } from "./presentation/routes/ride-lifecycle.routes";
import {
  onboardingRouter,
  passengersNetworkRouter,
  driversNetworkRouter,
  networkLegacyRouter,
} from "./presentation/routes/network-v2.routes";
import { genealogyRouter } from "./presentation/routes/genealogy.routes";
import { ExpireOffersService } from "./application/use-cases/ExpireOffersService";
import { prisma } from "./infra/prisma/client";

dotenv.config();

const allowedOrigins = [
  "http://localhost:3000",
  "http://localhost:3001",
];

const app = express();

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) {
      return callback(null, true);
    }

    if (
      allowedOrigins.includes(origin) ||
      origin.includes(".vercel.app")
    ) {
      return callback(null, true);
    }

    console.log("❌ CORS bloqueado:", origin);

    return callback(new Error("Not allowed by CORS"));
  },
  credentials: true,
}));

app.options("/{*corsPreflight}", cors());
app.use(express.json());

app.use((req, res, next) => {
  console.log("➡️", req.method, req.url);
  next();
});

app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.use("/", canonicalPublicRoutes);
app.use("/public", publicRoutes);
app.use("/auth", authRoutes);
app.use("/rides", rideRoutes);
app.use("/rides", ridesPaymentRouter);
app.use("/rides", rideLifecycleRouter);
app.use("/webhooks", pixWebhookRouter);
app.use("/offers", offerRoutes);
app.use("/passengers", passengerRoutes);
app.use("/passengers", passengersNetworkRouter);
app.use("/drivers", driverRoutes);
app.use("/drivers", driversNetworkRouter);
app.use("/drivers", genealogyRouter);
app.use("/onboarding", onboardingRouter);
app.use("/network", networkLegacyRouter);
app.use("/godnetwork", godnetworkRoutes);

if (process.env.NODE_ENV !== "production") {
  app.use("/test", testRoutes);

  app.get("/debug/users", async (req, res) => {
    const users = await prisma.user.findMany({ select: { email: true, role: true } });
    console.log("🚨 [/debug/users] DATABASE_URL:", process.env.DATABASE_URL);
    console.log("🚨 [/debug/users] Users in DB:", users.map((user) => user.email));
    return res.json({ DATABASE_URL: process.env.DATABASE_URL, users });
  });
}

app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
  console.error("🔥 GLOBAL ERROR:", err);

  res.status(500).json({
    error: "Internal server error",
  });
});

if (process.env.NODE_ENV !== "test") {
  const expireOffersService = new ExpireOffersService();
  setInterval(() => {
    expireOffersService.execute().catch((err) => {
      console.error("🔥 Erro no job de expiração de offers:", err);
    });
  }, 10_000);

  app.listen(3000, () => {
    console.log("🚀 Server running on port 3000");
    console.log("⏱️ Job de expiração de offers ativo (a cada 10s)");
  });
}

export { app };
