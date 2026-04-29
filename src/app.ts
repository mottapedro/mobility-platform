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

dotenv.config();

const app = express();

app.use(cors({ origin: "http://localhost:3001" }));
app.use(express.json());

app.use("/rides", rideRoutes);
app.use("/offers", offerRoutes);
app.use("/passengers", passengerRoutes);
app.use("/drivers", driverRoutes);
app.use("/auth", authRoutes);

if (process.env.NODE_ENV !== "production") {
  app.use("/test", testRoutes);
}

export { app };
