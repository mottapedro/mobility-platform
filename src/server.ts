import express from "express";
import dotenv from "dotenv";
import "dotenv/config"; // 👈 DEVE ser a primeira linha

import { rideRoutes } from "./presentation/routes/ride.routes";
import { offerRoutes } from "./presentation/routes/offer.routes";

dotenv.config();

const app = express();
app.use(express.json());

app.use("/rides", rideRoutes);
app.use("/offers", offerRoutes);

app.listen(3000, () => {
  console.log("🚀 Server running on port 3000");
});