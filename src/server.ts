import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import "dotenv/config"; // 👈 DEVE ser a primeira linha

import { rideRoutes } from "./presentation/routes/ride.routes";
import { offerRoutes } from "./presentation/routes/offer.routes";
import { passengerRoutes } from "./presentation/routes/passenger.routes";
import { driverRoutes } from "./presentation/routes/driver.routes";
import { ExpireOffersService } from "./application/use-cases/ExpireOffersService";

dotenv.config();

const allowedOrigins = [
  "http://localhost:3000",
  "http://localhost:3001",
  "https://mobility-platform-frontend.vercel.app",
];

const app = express();
app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);

    if (
      allowedOrigins.includes(origin) ||
      origin.includes(".vercel.app") // 🔥 LIBERA TODOS OS DEPLOYS
    ) {
      return callback(null, true);
    }

    console.log("❌ CORS bloqueado:", origin);
    return callback(new Error("Not allowed by CORS"));
  },
  credentials: true,
}));
app.use(express.json());

app.use("/rides", rideRoutes);
app.use("/offers", offerRoutes);
app.use("/passengers", passengerRoutes);
app.use("/drivers", driverRoutes);

if (process.env.NODE_ENV !== "test") {
  // ⏱️ Job: expira offers pendentes vencidas a cada 10s
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