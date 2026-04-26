import express from "express";
import cors from "cors";
import "dotenv/config";
import dotenv from "dotenv";

import { rideRoutes } from "./presentation/routes/ride.routes";
import { offerRoutes } from "./presentation/routes/offer.routes";
import { passengerRoutes } from "./presentation/routes/passenger.routes";

dotenv.config();

const app = express();

app.use(cors({ origin: "http://localhost:3001" }));
app.use(express.json());

app.use("/rides", rideRoutes);
app.use("/offers", offerRoutes);
app.use("/passengers", passengerRoutes);

export { app };
