import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import "dotenv/config";

import { authRoutes } from "./presentation/routes/auth.routes"; // 👈 FALTAVA
import { rideRoutes } from "./presentation/routes/ride.routes";
import { offerRoutes } from "./presentation/routes/offer.routes";
import { passengerRoutes } from "./presentation/routes/passenger.routes";
import { driverRoutes } from "./presentation/routes/driver.routes";
import { ExpireOffersService } from "./application/use-cases/ExpireOffersService";

dotenv.config();

const app = express();

const allowedOrigins = [
  "http://localhost:3000",
  "http://localhost:3001",
  "https://mobility-platform-frontend.vercel.app",
];

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);

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

app.use(express.json());

app.use("/auth", authRoutes); // 👈 ESSENCIAL
app.use("/rides", rideRoutes);
app.use("/offers", offerRoutes);
app.use("/passengers", passengerRoutes);
app.use("/drivers", driverRoutes);