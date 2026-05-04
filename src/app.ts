import express from "express";
import cors from "cors";
import "dotenv/config";
import dotenv from "dotenv";

import { rideRoutes } from "./presentation/routes/ride.routes";
import { offerRoutes } from "./presentation/routes/offer.routes";
import { passengerRoutes } from "./presentation/routes/passenger.routes";
import { driverRoutes } from "./presentation/routes/driver.routes";
import { authRoutes } from "./presentation/routes/auth.routes";
import { testRoutes } from "./presentation/routes/test.routes";
import { prisma } from "./infra/prisma/client";

dotenv.config();

const app = express();

app.use(cors({
  origin: ["http://localhost:3001", /\.ngrok-free\.app$/, /\.vercel\.app$/],
  methods: ["GET", "POST", "PATCH", "DELETE"],
  allowedHeaders: ["Content-Type", "Authorization"],
}));
app.use(express.json());

app.use((req, res, next) => {
  console.log(`[${req.method}] ${req.url}`);
  next();
});

app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.use("/rides", rideRoutes);
app.use("/offers", offerRoutes);
app.use("/passengers", passengerRoutes);
app.use("/drivers", driverRoutes);
app.use("/auth", authRoutes);

if (process.env.NODE_ENV !== "production") {
  app.use("/test", testRoutes);

  app.get("/debug/users", async (req, res) => {
    const users = await prisma.user.findMany({ select: { email: true, role: true } });
    console.log("🚨 [/debug/users] DATABASE_URL:", process.env.DATABASE_URL);
    console.log("🚨 [/debug/users] Users in DB:", users.map(u => u.email));
    return res.json({ DATABASE_URL: process.env.DATABASE_URL, users });
  });
}

export { app };
