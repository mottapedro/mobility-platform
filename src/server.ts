import express from "express";
import dotenv from "dotenv";
import "dotenv/config"; // 👈 DEVE ser a primeira linha

import { rideRoutes } from "./presentation/routes/ride.routes";
import { offerRoutes } from "./presentation/routes/offer.routes";
import { ExpireOffersService } from "./application/use-cases/ExpireOffersService";

dotenv.config();

const app = express();
app.use(express.json());

app.use("/rides", rideRoutes);
app.use("/offers", offerRoutes);

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